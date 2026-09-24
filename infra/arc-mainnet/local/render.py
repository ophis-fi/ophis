#!/usr/bin/env python3
"""Render only local service endpoints and addresses from a checked local manifest."""
import argparse
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--with-lifi', action='store_true')
parser.add_argument('--with-kyberswap', action='store_true')
parser.add_argument('--automatic-settlement', action='store_true')
parser.add_argument('--uniswap-only', action='store_true')
args = parser.parse_args()
lanes = [('uniswap-v3', 7880), ('synthra', 7877), ('achswap', 7878)]
if args.uniswap_only:
    lanes = lanes[:1]
if args.with_lifi:
    lanes.append(('lifi', 7879))
if args.with_kyberswap:
    lanes.append(('kyberswap', 7881))
out = HERE / 'generated'
m = json.loads((out / 'deployment.json').read_text())
assert m['localOnly'] is True and m['chainId'] == 5042
assert m['rpc'] == 'http://127.0.0.1:8547'
rpc = 'http://127.0.0.1:8548'  # Count backend calls; forwards only to local Anvil.
assert args.automatic_settlement == m.get('automaticSettlement', False)
account = f'"{m["solver"]}"'
if args.automatic_settlement:
    assert (out / 'anvil-solver.key').is_file()
    account = (f'{{ guarded = {{ path = "{out / "anvil-solver.key"}" }}, '
               f'settlement-targets = [{{ address = "{m["settlement"]}", selectors = ["0x13d79a0b"] }}], '
               'require-zero-value = true }')
usdc = '0x3600000000000000000000000000000000000000'
quote_drivers = ', '.join(f'{{name = "{name}", url = "http://127.0.0.1:11087/{name}"}}' for name, _ in lanes)
native_estimators = ', '.join(f'{{type = "Driver", name = "{name}", url = "http://127.0.0.1:11087/{name}"}}' for name, _ in lanes)
auction_drivers = ''.join(f'''[[drivers]]
name = "{name}"
url = "http://127.0.0.1:11087/{name}"
address = "{m['solver']}"
''' for name, _ in lanes)
solver_configs = ''.join(f'''[[solver]]
name = "{name}"
endpoint = "http://127.0.0.1:{port}"
# Default is address-only; explicit automatic mode uses the guarded Anvil signer.
account = {account}
relative-slippage = "0.01"
absolute-slippage = "1000000000000000000"
skip-liquidity = true
manage-native-token = {{wrap-address = false, insert-unwraps = false}}
''' for name, port in lanes)
sentinel = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE'
contracts = f'''settlement = "{m['settlement']}"
balances = "{m['Balances']}"
signatures = "{m['Signatures']}"
hooks = "{m['HooksTrampoline']}"
native-token = "{usdc}"
balancer-v2-vault = "{m['vault']}"
'''
common = f'''
[database]
write-url = "postgresql://arc:arc-local@127.0.0.1:15447/arc"
max-connections = 4
[order-quoting]
price-estimation-drivers = [{quote_drivers}]
[price-estimation]
amount-to-estimate-prices-with = "1000000"
quote-verification = "enforce-when-possible"
[price-estimation.balance-overrides.token-overrides.{usdc}]
type = "ArcUsdc"
'''
orderbook = f'''bind-address = "127.0.0.1:8087"
unsupported-tokens = ["{sentinel}"]
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
estimators = [[{{type = "Forwarder", url = "http://127.0.0.1:12087"}}]]
{common}'''
autopilot = f'''node-url = "{rpc}"
simulation-node-url = "{rpc}"
chain-id = 5042
api-address = "127.0.0.1:12087"
metrics-address = "127.0.0.1:9587"
unsupported-tokens = ["{sentinel}"]
[contracts]
{contracts}
[current-block]
poll-interval = "30s"
[ethrpc]
max-concurrent-requests = 2
[ethflow]
contracts = []
skip-event-sync = true
{auction_drivers}
[fee-policies]
policies = []
[run-loop]
solve-deadline = "20s"
max-delay = "15s"
max-winners-per-auction = 1
# One-second lab blocks: allow the 30s poll and 20s solver window.
submission-deadline = 120
[native-price-estimation]
estimators = [[{native_estimators}]]
cache-refresh-interval = "30s"
prefetch-time = "30s"
[native-price-estimation.cache]
max-age = "5m"
concurrent-requests = 1
{common}'''
driver = f'''chain-id = 5042
tx-gas-limit = "10000000"
disable-access-list-simulation = true
orderbook-url = "http://127.0.0.1:8087"
[contracts]
gp-v2-settlement = "{m['settlement']}"
weth = "{usdc}"
balances = "{m['Balances']}"
signatures = "{m['Signatures']}"
{solver_configs}
[submission]
gas-price-cap = "100000000000"
[[submission.mempool]]
url = "{rpc}"
[liquidity]
base-tokens = ["{usdc}"]
'''
dex_common = f'''node-url = "{rpc}"
settlement = "{m['settlement']}"
wrapped-native = "{usdc}"
concurrent-requests = 1
internalize-interactions = false
strict-output-simulation = true
strict-market-output-simulation = "all"
'''
lifi = dex_common + '''[dex]
chain-id = "5042"
integrator = "ophis"
endpoint = "http://127.0.0.1:8787/v1/"
'''
for name, content in [('orderbook', orderbook), ('autopilot', autopilot), ('driver', driver)]:
    (out / f'{name}.toml').write_text(content)
for name, _ in lanes:
    content = lifi if name == 'lifi' else dex_common + f'[dex]\nchain-id = "5042"\nvenue = "{name}"\n'
    if name == 'kyberswap':
        content = dex_common + '[dex]\nchain-id = "5042"\nendpoint = "http://127.0.0.1:8788/arc/api/v1/"\n'
    (out / f'{name}.toml').write_text(content)
(out / 'lanes.json').write_text(json.dumps(lanes))
print('Rendered local-only lanes:', ', '.join(name for name, _ in lanes))
