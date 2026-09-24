#!/usr/bin/env python3
"""Prepare production files offline; activation requires a fresh verified deployment."""
import argparse
import json
import os
from pathlib import Path
import secrets
import subprocess
import time
try:
    import tomllib
except ImportError:  # Python 3.9 on the existing operator host.
    import tomli as tomllib
import yaml

HERE = Path(__file__).resolve().parent
OUT = HERE / 'generated'
USDC = '0x3600000000000000000000000000000000000000'
SENTINEL = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE'


def render(active=False):
    if not active:
        for name in ['receipts.json', 'verified.json']:
            assert not (OUT / name).exists(), 'Refusing to overwrite deployed release configuration: ' + name
        if (OUT / 'activation.json').exists():
            assert json.loads((OUT / 'activation.json').read_text()).get('active') is False, 'Refusing to overwrite active release configuration'
    plan = json.loads((OUT / 'plan.json').read_text())
    subprocess.run(['node', '-e', "const p=require('./plan.cjs');p.checkHash(JSON.parse(require('fs').readFileSync('./generated/plan.json')))"], cwd=HERE, check=True)
    c, cfg = plan['contracts'], plan['config']
    verified = json.loads((OUT / 'verified.json').read_text()) if (OUT / 'verified.json').exists() else None
    if active:
        assert verified and verified['planHash'] == plan['hash'] and verified['localOnly'] is False
        from datetime import datetime
        assert 0 <= time.time() - datetime.fromisoformat(verified['verifiedAt'].replace('Z', '+00:00')).timestamp() < 3600, 'Re-run verify.cjs before activation'
        assert verified['contracts'] == c and verified['solver'] == cfg['solver']
    def write(name, value):
        file = OUT / name
        file.write_text(value)
        file.chmod(0o600)
    for name in ['postgres-password', 'service-token']:
        if not (OUT / name).exists():
            write(name, secrets.token_hex(32))
    password = (OUT / 'postgres-password').read_text().strip()
    assert len(password) == 64 and all(x in '0123456789abcdef' for x in password)
    # Compose reads this on the host; database/migration container UIDs need not
    # read a host-owned 0600 bind-mounted secret file.
    write('database.env', f'POSTGRES_PASSWORD={password}\nFLYWAY_PASSWORD={password}\n')
    token = (OUT / 'service-token').read_text().strip()
    write('services.env', f'OPHIS_INTER_SERVICE_AUTH_TOKEN={token}\n')
    rpc = 'http://rpc-proxy:4000/main/evm/5042'
    contracts = '\n'.join(f'{key} = "{c[value]}"' for key, value in [('settlement', 'settlement'), ('balances', 'Balances'), ('signatures', 'Signatures'), ('hooks', 'HooksTrampoline'), ('balancer-v2-vault', 'vault')]) + f'\nnative-token = "{USDC}"\n'
    common = f'''[database]
write-url = "postgresql://arc:{password}@postgres:5432/arc"
max-connections = 4
[order-quoting]
price-estimation-drivers = [{{name = "uniswap-v3", url = "http://driver:11088/uniswap-v3"}}]
[price-estimation]
amount-to-estimate-prices-with = "1000000"
quote-verification = "enforce-when-possible"
[price-estimation.balance-overrides.token-overrides.{USDC}]
type = "ArcUsdc"
'''
    orderbook = f'''bind-address = "0.0.0.0:8080"
unsupported-tokens = ["{SENTINEL}"]
[shared]
chain-id = 5042
node-url = "{rpc}"
simulation-node-url = "{rpc}"
[shared.current-block]
poll-interval = "30s"
[shared.ethrpc]
max-concurrent-requests = 2
[shared.contracts]
{contracts}
[native-price-estimation]
estimators = [[{{type = "Forwarder", url = "http://autopilot:12088"}}]]
{common}'''
    deployment_block = verified['settlementDeploymentBlock'] if active else 0
    autopilot = f'''node-url = "{rpc}"
simulation-node-url = "{rpc}"
chain-id = 5042
settlement-deployment-block = {deployment_block}
api-address = "0.0.0.0:12088"
metrics-address = "0.0.0.0:9587"
unsupported-tokens = ["{SENTINEL}"]
[contracts]
{contracts}
[current-block]
poll-interval = "30s"
[ethrpc]
max-concurrent-requests = 2
[ethflow]
contracts = []
skip-event-sync = false
[[drivers]]
name = "uniswap-v3"
url = "http://driver:11088/uniswap-v3"
address = "{cfg['solver']}"
[fee-policies]
policies = []
[run-loop]
solve-deadline = "20s"
max-delay = "15s"
max-winners-per-auction = 1
submission-deadline = {cfg['submissionDeadlineBlocks']}
[native-price-estimation]
estimators = [[{{type = "Driver", name = "uniswap-v3", url = "http://driver:11088/uniswap-v3"}}]]
cache-refresh-interval = "30s"
prefetch-time = "30s"
[native-price-estimation.cache]
max-age = "5m"
concurrent-requests = 1
{common}'''
    account = (f'{{ guarded = {{ path = "/run/secrets/solver-key" }}, settlement-targets = [{{ address = "{c["settlement"]}", selectors = ["0x13d79a0b"] }}], require-zero-value = true }}' if active else f'"{cfg["solver"]}"')
    driver = f'''chain-id = 5042
# Use the node's current gas price; Alloy's 2x base-fee estimate exceeds Arc's reviewed cap.
gas-estimator = {{estimator = "web3"}}
tx-gas-limit = "{cfg['gasLimit']}"
disable-access-list-simulation = true
orderbook-url = "http://orderbook:8080"
[contracts]
gp-v2-settlement = "{c['settlement']}"
weth = "{USDC}"
balances = "{c['Balances']}"
signatures = "{c['Signatures']}"
[[solver]]
name = "uniswap-v3"
endpoint = "http://uniswap-v3:7877"
account = {account}
relative-slippage = "0.01"
absolute-slippage = "1000000000000000000"
skip-liquidity = true
manage-native-token = {{wrap-address = false, insert-unwraps = false}}
[submission]
gas-price-cap = "{cfg['maxFeePerGas']}"
[[submission.mempool]]
url = "{rpc}"
additional-tip-percentage = 0.0
[liquidity]
base-tokens = ["{USDC}"]
'''
    solver = f'''node-url = "{rpc}"
settlement = "{c['settlement']}"
wrapped-native = "{USDC}"
concurrent-requests = 1
internalize-interactions = false
strict-output-simulation = true
strict-market-output-simulation = "all"
[dex]
chain-id = "5042"
venue = "uniswap-v3"
'''
    for name, content in [('orderbook', orderbook), ('autopilot', autopilot), ('driver', driver), ('uniswap-v3', solver)]:
        tomllib.loads(content)
        write(name + '.toml', content)
    erpc = yaml.safe_load((HERE.parent / 'erpc.yaml').read_text())
    # Driver mempools also read nonces here. Preserve two-voter reads; only the
    # official public upstream may relay a signed transaction, with no retry.
    upstream = erpc['projects'][0]['upstreams'][0]
    upstream['allowMethods'] = [*upstream['allowMethods'], 'eth_sendRawTransaction']
    write('erpc.yaml', yaml.safe_dump(erpc, sort_keys=False))
    write('frontend.env', f'''REACT_APP_ARC_ENABLED={str(active).lower()}
REACT_APP_ARC_LOCAL=false
REACT_APP_ARC_SETTLEMENT={c['settlement']}
REACT_APP_ARC_VAULT_RELAYER={c['vaultRelayer']}
REACT_APP_ARC_ORDERBOOK_URL={cfg['orderbookUrl']}
''')
    write('nginx.conf', '''events {}
http {
  map $http_origin $allowed_origin {
    default "";
    "''' + cfg['frontendOrigin'] + '''" $http_origin;
    "''' + cfg['explorerOrigin'] + '''" $http_origin;
  }
  limit_req_zone arc-quotes zone=quotes:1m rate=6r/m;
  limit_req_zone $binary_remote_addr zone=reads:1m rate=3r/s;
  server {
    listen 8080;
    client_max_body_size 256k;
    limit_req_status 429;
    add_header Access-Control-Allow-Origin $allowed_origin always;
    add_header Vary Origin always;
    add_header Access-Control-Allow-Headers "Content-Type" always;
    add_header Access-Control-Allow-Methods "GET, POST, DELETE, OPTIONS" always;
    if ($request_method = OPTIONS) { return 204; }
    location = /api/v1/quote {
      limit_req zone=quotes burst=5 nodelay;
      proxy_hide_header Access-Control-Allow-Origin;
      proxy_pass http://orderbook:8080;
    }
    location /api/v1/ {
      limit_req zone=reads burst=6 nodelay;
      proxy_hide_header Access-Control-Allow-Origin;
      proxy_pass http://orderbook:8080;
    }
    location = /api/v2/trades {
      limit_req zone=reads burst=6 nodelay;
      proxy_hide_header Access-Control-Allow-Origin;
      proxy_pass http://orderbook:8080;
    }
    location / { return 404; }
  }
}
''')
    write('activation.json', json.dumps({'active': active, 'planHash': plan['hash']}))
    print('Rendered verified active release.' if active else 'Rendered inactive release preview; no signer and no public frontend activation.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--activate', action='store_true')
    render(parser.parse_args().activate)
