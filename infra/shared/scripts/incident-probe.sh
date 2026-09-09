#!/usr/bin/env bash
set -euo pipefail
python3 - <<'PY'
import concurrent.futures, datetime, json, re, subprocess, time, urllib.request, urllib.parse

def get(url, payload=None):
    body = None if payload is None else json.dumps(payload).encode()
    request = urllib.request.Request(url, data=body, headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(request, timeout=15) as response:
        return json.load(response)

def prom(expression, history=False):
    params = {'query': expression, 'timeout': '10s'}
    if history:
        params.update(start=time.time()-5400, end=time.time(), step=300)
    result = get('http://localhost:9096/api/v1/' + ('query_range' if history else 'query') + '?' + urllib.parse.urlencode(params))
    assert result['status'] == 'success', result
    return result['data']['result']

def rpc(url, method, params):
    return get(url, {'jsonrpc': '2.0', 'id': 1, 'method': method, 'params': params})

def head(url):
    result = rpc(url, 'eth_getBlockByNumber', ['latest', False])
    if 'result' not in result or result['result'] is None:
        return result
    block = result['result']
    return {k: int(block[k], 16) for k in ('number', 'timestamp', 'gasUsed')} | {'hash': block['hash'], 'transactions': len(block['transactions'])}

def run(command):
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=20)
        return {'code': result.returncode, 'output': re.sub(r'https?://[^\s"<>]+', '[RPC-URL]', result.stdout + result.stderr)[-18000:]}
    except subprocess.TimeoutExpired:
        return {'error': '20s timeout'}

def alerts():
    return [{k: alert[k] for k in ('labels', 'state', 'activeAt', 'value')} for alert in get('http://localhost:9096/api/v1/alerts')['data']['alerts']]

tasks = {
    'alerts': alerts,
    'host_disk': lambda: run(['df', '-h', '/']),
    'host_memory': lambda: run(['free', '-m']),
    'containers': lambda: run(['docker', 'ps', '--format', '{{.Names}} {{.Status}}']),
    'nitro_state': lambda: run(['docker', 'inspect', 'robinhood-nitro-nitro-1', '--format', '{{json .State}} restarts={{.RestartCount}}']),
    'driver_health': lambda: get('http://localhost:8411/healthz'),
    'failure_ratio': lambda: prom('sum(rate(erpc_consensus_errors_total{network="evm:4663"}[5m])) / sum(rate(erpc_consensus_total{network="evm:4663"}[5m]))'),
    'failure_history': lambda: prom('sum(rate(erpc_consensus_errors_total{network="evm:4663"}[5m])) / sum(rate(erpc_consensus_total{network="evm:4663"}[5m]))', True),
    'lag_history': lambda: prom('erpc_upstream_block_head_lag{network="evm:4663"}', True),
    'consensus_errors': lambda: prom('sum by(category,error) (rate(erpc_consensus_errors_total{network="evm:4663"}[5m]))'),
    'upstream_errors': lambda: prom('sum by(upstream,method,error) (rate(erpc_upstream_request_errors_total{network="evm:4663"}[5m])) > 0'),
    'upstream_error_history': lambda: prom('sum by(upstream,error) (rate(erpc_upstream_request_errors_total{network="evm:4663"}[5m])) > 0', True),
    'app_heads': lambda: prom('{__name__=~".*last_block_number.*"}'),
    'settlements': lambda: prom('sum by(result) (increase(settlements[1h]))'),
    'self_sync': lambda: rpc('http://localhost:8547', 'eth_syncing', []),
}
for name in ('robinhood-mainnet-driver-1', 'robinhood-mainnet-autopilot-1', 'robinhood-mainnet-rpc-proxy-1', 'robinhood-nitro-nitro-1'):
    tasks[name + '_logs'] = lambda name=name: run(['docker', 'logs', '--since', '60m', '--tail', '80', name])

print('START', datetime.datetime.now(datetime.timezone.utc).isoformat(), flush=True)
with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
    futures = {pool.submit(task): name for name, task in tasks.items()}
    for future in concurrent.futures.as_completed(futures):
        try:
            result = future.result()
        except Exception as error:
            result = {'error': str(error)}
        print(futures[future], json.dumps(result), flush=True)

urls = {'self': 'http://localhost:8547', 'official': 'https://rpc.mainnet.chain.robinhood.com', 'erpc': 'http://localhost:4003/main/evm/4663'}
for sample in range(3):
    print('SAMPLE', sample, datetime.datetime.now(datetime.timezone.utc).isoformat(), flush=True)
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        futures = {pool.submit(head, url): name for name, url in urls.items()}
        for future in concurrent.futures.as_completed(futures):
            try:
                result = future.result()
            except Exception as error:
                result = {'error': str(error)}
            print('head_' + futures[future], json.dumps(result), flush=True)
    for name, url in urls.items():
        try:
            result = rpc(url, 'eth_getBalance', ['0x95f0beaB29BeA3D18A7c81140AED9227Ff2D7665', 'latest'])
        except Exception as error:
            result = {'error': str(error)}
        print('balance_' + name, json.dumps(result), flush=True)
    if sample < 2:
        time.sleep(20)
PY
