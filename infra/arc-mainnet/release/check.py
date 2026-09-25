#!/usr/bin/env python3
"""Offline release checks; HTTP containers have no external network access."""
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import tempfile
import uuid
import yaml
try:
    import tomllib
except ImportError:
    import tomli as tomllib

HERE = Path(__file__).resolve().parent
OUT = HERE / 'generated'
sys.path.insert(0, str(HERE.parent))
from test_rpc import docker


def main():
    # Checks render inactive files: never overwrite a deployed or active release.
    for name in ['receipts.json', 'verified.json']:
        assert not (OUT / name).exists(), 'Refusing to modify deployed release state: ' + name
    if (OUT / 'activation.json').exists():
        assert json.loads((OUT / 'activation.json').read_text()).get('active') is False, 'Refusing to modify active release files'
    # Do not overwrite an operator's prepared plan. CI starts from a clean checkout.
    if not (OUT / 'plan.json').exists():
        config = json.loads((HERE / 'config.example.json').read_text())
        # Preview identities have no known signing keys and cannot match the Ledger.
        for role in ['deployer', 'safe', 'solver']:
            config[role] = '0x' + secrets.token_hex(20)
        with tempfile.TemporaryDirectory(prefix='arc-release-check-') as directory:
            fixture = Path(directory) / 'config.json'
            fixture.write_text(json.dumps(config))
            subprocess.run(['node', str(HERE / 'plan.cjs'), str(fixture)], check=True)
    subprocess.run([sys.executable, str(HERE / 'render.py')], check=True)
    erpc = yaml.safe_load((OUT / 'erpc.yaml').read_text())
    cfg = json.loads((OUT / 'plan.json').read_text())['config']
    allowed_origins = [cfg['frontendOrigin'], cfg['explorerOrigin']]
    assert erpc['projects'][0]['upstreams'][-1]['endpoint'] == 'http://credit-gate:8080'
    submit = [u for u in erpc['projects'][0]['upstreams'] if 'eth_sendRawTransaction' in u['allowMethods']]
    assert len(submit) == 1 and submit[0]['id'] == 'arc-official'
    assert submit[0]['rateLimitBudget'] == 'arc-official'
    assert 'guarded' not in (OUT / 'driver.toml').read_text()
    autopilot = tomllib.loads((OUT / 'autopilot.toml').read_text())
    orderbook = tomllib.loads((OUT / 'orderbook.toml').read_text())
    # Two bounded native-price legs must retain usable solver time after
    # driver/solver deadline margins; sharing avoids duplicate cold probes.
    assert autopilot['price-estimation']['quote-timeout'] == '10s'
    assert orderbook['price-estimation']['quote-timeout'] == '10s'
    assert 'api-estimators' not in autopilot['native-price-estimation']
    driver = tomllib.loads((OUT / 'driver.toml').read_text())
    assert driver['gas-estimator'] == {'estimator': 'web3'}
    assert int(driver['submission']['gas-price-cap']) == int(cfg['maxFeePerGas'])
    assert all(pool['additional-tip-percentage'] == 0 for pool in driver['submission']['mempool'])
    assert all(lane['address'] == cfg['solver'] for lane in autopilot['drivers'])
    assert all(lane['account'] == cfg['solver'] for lane in driver['solver'])
    lanes = {'uniswap-v3', 'kyberswap'}
    assert {lane['name'] for lane in driver['solver']} == lanes
    assert len(autopilot['drivers']) == 2
    assert autopilot['run-loop']['max-winners-per-auction'] == 1
    for name in lanes:
        solver = tomllib.loads((OUT / (name + '.toml')).read_text())
        assert solver['strict-output-simulation'] is True
        assert solver['strict-market-output-simulation'] == 'all'
        assert solver['concurrent-requests'] == 1
    assert all(lane['manage-native-token'] == {'wrap-address': False, 'insert-unwraps': False} for lane in driver['solver'])
    assert 'skip-event-sync = false' in (OUT / 'autopilot.toml').read_text()
    assert 'REACT_APP_ARC_ENABLED=false' in (OUT / 'frontend.env').read_text()
    assert subprocess.run([sys.executable, str(HERE / 'render.py'), '--activate'], capture_output=True).returncode != 0, 'Unverified plan activated'
    pilot = yaml.safe_load((HERE.parent / 'docker-compose.yml').read_text())
    release = yaml.safe_load((HERE / 'docker-compose.yml').read_text())
    assert pilot['volumes']['credits']['name'] == release['volumes']['credits']['name'] == 'ophis-arc-quicknode-credits'
    for compose in [pilot, release]:
        assert 'ARC_QUICKNODE_RPC_URL' not in compose['services']['rpc-proxy'].get('environment', {})
        assert not compose['services']['credit-gate'].get('ports')
    env = {**os.environ, 'ARC_RUNTIME_UID': str(os.getuid()), 'ARC_RUNTIME_GID': str(os.getgid()), 'ARC_RELEASE_TAG': 'local-check', 'ARC_QUICKNODE_RPC_URL': 'https://placeholder.arc-mainnet.quiknode.pro/placeholder', 'ARC_QUICKNODE_CREDIT_ALLOWANCE': '100', 'ARC_SOLVER_KEY_FILE': '/dev/null'}
    assert release['services']['driver']['user'] == release['services']['rpc-proxy']['user']
    assert release['services']['postgres']['env_file'] == './generated/database.env'
    subprocess.run(['docker', 'compose', '-f', str(HERE / 'docker-compose.yml'), 'config', '--quiet'], env=env, check=True)
    # Create files inside Linux: macOS bind mounts can remap ownership and hide
    # the production failure of a hardcoded image UID reading host-owned 0600 files.
    permissions = '''import os,tempfile
root=tempfile.mkdtemp();os.chown(root,12345,12345);os.chmod(root,0o700)
file=root+'/config';open(file,'w').write('private');os.chown(file,12345,12345);os.chmod(file,0o600)
for uid in [10001,12345]:
 pid=os.fork()
 if pid==0:
  os.setgid(uid);os.setuid(uid)
  try: readable=open(file).read()=='private'
  except PermissionError: readable=False
  os._exit(0 if readable==(uid==12345) else 1)
 assert os.waitpid(pid,0)[1]==0
print('PASS Linux private config/key ownership boundary')
'''
    print(docker('run', '--rm', '--network', 'none', pilot['services']['credit-gate']['image'], 'python', '-c', permissions))
    network = 'arc-release-check-' + uuid.uuid4().hex[:8]
    backend, api = network + '-backend', network + '-api'
    try:
        docker('network', 'create', '--internal', network)
        docker('run', '-d', '--name', backend, '--network', network, '--network-alias', 'orderbook',
               pilot['services']['credit-gate']['image'], 'python', '-c',
               "import http.server,os,pathlib,tempfile;os.chdir(tempfile.mkdtemp());"
               "pathlib.Path('api/v2').mkdir(parents=True);"
               "pathlib.Path('api/v2/trades').write_text('[]');"
               "pathlib.Path('api/v2/other').write_text('[]');"
               "http.server.test(HandlerClass=http.server.SimpleHTTPRequestHandler,port=8080)")
        docker('run', '-d', '--name', api, '--network', network,
               '-v', f'{OUT / "nginx.conf"}:/etc/nginx/nginx.conf:ro', release['services']['api']['image'])
        code = '''import json,time,urllib.request,urllib.error
for i in range(40):
 try:
  urllib.request.urlopen('http://127.0.0.1:8080/'); break
 except OSError: time.sleep(.1)
for i in range(40):
 try:
  urllib.request.urlopen('http://''' + api + ''':8080/')
 except urllib.error.HTTPError: break
 except OSError: time.sleep(.1)
codes=[]
for i in range(8):
 try:
  r=urllib.request.urlopen('http://''' + api + ''':8080/api/v1/quote'+('/draft' if i%2 else ''))
  codes.append(r.status)
 except urllib.error.HTTPError as e: codes.append(e.code)
assert codes==[404]*6+[429,429],codes
print('PASS live Nginx quote rate limit:',codes)
allowed=''' + repr(allowed_origins) + '''
for origin in allowed+['https://untrusted.example']:
 request=urllib.request.Request('http://''' + api + ''':8080/api/v1/app_data/'+'0'*64,
  method='OPTIONS',headers={'Origin':origin,'Access-Control-Request-Method':'PUT',
  'Access-Control-Request-Headers':'content-type'})
 response=urllib.request.urlopen(request)
 assert response.status==204
 assert response.headers.get('Access-Control-Allow-Origin')==(origin if origin in allowed else None)
 assert 'PUT' in response.headers.get('Access-Control-Allow-Methods','').split(', ')
 assert 'content-type' in response.headers.get('Access-Control-Allow-Headers','').lower()
for origin in allowed+['https://untrusted.example']:
 for endpoint in ['/api/v1/version','/api/v2/trades?orderUid=fixture&offset=0&limit=10']:
  request=urllib.request.Request('http://''' + api + ''':8080'+endpoint,headers={'Origin':origin})
  try: response=urllib.request.urlopen(request)
  except urllib.error.HTTPError as e: response=e
  assert response.headers.get('Access-Control-Allow-Origin')==(origin if origin in allowed else None)
  if endpoint.startswith('/api/v2/'):
   assert response.status==200 and json.loads(response.read())==[], 'SDK trades route did not reach the backend'
try: urllib.request.urlopen('http://''' + api + ''':8080/api/v2/other')
except urllib.error.HTTPError as e: assert e.code==404
else: raise AssertionError('Unintended v2 API exposed')
# Cloudflare supplies the real client header through the loopback-only tunnel.
# Exhaust one client's bucket without throttling a different visitor.
for client in ['198.51.100.1','198.51.100.2']:
 codes=[]
 for i in range(12):
  request=urllib.request.Request('http://''' + api + ''':8080/api/v2/trades',headers={'CF-Connecting-IP':client})
  try: codes.append(urllib.request.urlopen(request).status)
  except urllib.error.HTTPError as e: codes.append(e.code)
 assert codes[0]==200 and 429 in codes,codes
print('PASS SDK v2 trades, exact route boundary, per-client rate limit and swap/explorer CORS allowlist')
'''
        print(docker('exec', backend, 'python', '-c', code))
    finally:
        for name in [api, backend]:
            subprocess.run(['docker', 'rm', '-f', name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        subprocess.run(['docker', 'network', 'rm', network], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    print('PASS release preview, activation rejection, shared durable budget, private RPC lanes and Compose validation; zero public RPC calls')


if __name__ == '__main__':
    main()
