# Ethereum RPC consumers (baal)

baal is the self-hosted Ethereum mainnet node (Reth execution client, Nimbus
consensus client, one active validator). Its JSON-RPC endpoint is
`http://100.69.134.7:8547`, reachable only over Tailscale. Everything below
uses it for Ethereum execution reads only; nothing in this directory runs on
baal itself.

## What baal serves

| Capability | Limit |
| --- | --- |
| Namespaces | `eth`, `net`, `web3` (no `debug`, `trace`, `txpool`) |
| State (`eth_call`, balances, code, storage) | last 10,064 blocks (about 33 h) |
| Blocks, receipts, logs | from the merge (block 15,537,394) onward |
| Transaction lookup by hash | last 10,064 blocks; older hashes return `null` |
| `eth_getLogs` | at most 100,000 blocks and 20,000 results per call |
| Beacon API | no blobs (PeerDAS custody 4 of 128 columns) |

It is one home machine without a UPS. Every production consumer keeps a
public fallback. viem's `fallback` transport and the Nitro proxy retry on
errors, not on a `null` result, so do not send by-hash lookups older than
33 h to baal.

Reachable from: Clément's Macs (all ports) and cadia-wsl (8547 only). Visitors'
browsers, Cloudflare, GitHub-hosted runners and users' machines cannot reach it.

## Consumers

| Consumer | Where | Setting | Fallback |
| --- | --- | --- | --- |
| Robinhood Nitro parent-chain reads | cadia-wsl, `/home/clement/robinhood-nitro` | `L1_EXECUTION_RPC=http://l1-execution-proxy:8545`, `L1_PRIMARY_UPSTREAM` | dRPC and MEV Blocker, through the proxy |
| Rebate indexer, chain 1 | cadia-wsl, `/srv/ophis/apps/rebate-indexer` | `SETTLE_RPC_URL_1` in the deployment `.env` | `SETTLE_RPC_FALLBACK_1` (PublicNode) |
| OTC consistency check, every 15 min | cadia-wsl, systemd `ophis-otc-canary.timer` | `OTC_CANARY_RPC_URL` (Compose default: baal) | none on purpose |
| Quote Lab V2/V3 baselines (timer disabled 2026-10-19) | cadia-wsl, systemd `ophis-quote-lab.timer` | `ETHEREUM_RPC_URL` in `run-quote-lab.sh` | none; a failed run writes no report |

### Why the settings live in this repository

`rebate-indexer-deploy.yml` rsyncs the repository to `/srv/ophis` with
`--delete` and then runs `docker compose up -d --build`. It keeps the
deployment `.env` and everything under `infra/`, but replaces
`apps/rebate-indexer/docker-compose.yml` with the checked-in file. On
2026-09-27 a deploy replaced a hand-edited Compose file: the `otc-canary`
service disappeared (the timer then failed every run) and `SETTLE_RPC_URL_1`
stopped reaching the indexer, which fell back to PublicNode. Any baal setting
that a deploy can overwrite must be in the checked-in file.

## 1. Rebate indexer

In the deployment `.env`:

```dotenv
SETTLE_RPC_URL_1=http://100.69.134.7:8547
```

Compose passes `SETTLE_RPC_URL_1` and `SETTLE_RPC_FALLBACK_1` through; the
client (`src/rpc/client.ts`) tries baal first with a 15 s timeout, then the
fallback. Chain 1 is read for settlement block timestamps, single-block
settlement logs in the nightly DefiLlama repair, and contract-wallet checks at
`latest`. baal serves all three; keyless PublicNode refuses historical log
reads. Keep chain 1 out of
`SETTLE_DECODER_CHAINS` and do not set `SETTLE_SCAN_START_BLOCK_1` while baal
is the primary: both paths call `getTransaction` by hash on historical blocks.

Check after a deploy:

```sh
docker inspect rebate-indexer-indexer-1 --format '{{range .Config.Env}}{{println .}}{{end}}' | grep '^SETTLE_RPC_URL_1='
```

Rollback: remove the line from `.env` and recreate the indexer.

## 2. OTC consistency check

`scripts/otc-mainnet-canary.mjs` checks chain ID, escrow bytecode, WETH wiring,
order data and subgraph freshness against direct Ethereum reads. It has no
fallback, so a failure shows a broken baal path instead of hiding it. The daily
GitHub canary stays the public-RPC check with Telegram alerts.

```sh
cd /srv/ophis/apps/rebate-indexer
docker compose --profile monitoring run --rm --no-deps otc-canary
sudo install -m 644 /srv/ophis/infra/ethereum-rpc/ophis-otc-canary.service /etc/systemd/system/
sudo install -m 644 /srv/ophis/infra/ethereum-rpc/ophis-otc-canary.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now ophis-otc-canary.timer
journalctl -u ophis-otc-canary.service -n 30 --no-pager
```

Results go to journald. `notify-otc-canary.sh` (the unit's `ExecStopPost`)
sends a Telegram message, with the bot and chat from the indexer `.env`, when
the check fails twice in a row and again when it passes; a failed send is
retried on the next run. Its state is `/var/lib/ophis-otc-canary/state`.
Rollback: `sudo systemctl disable --now ophis-otc-canary.timer`.

## 3. Quote Lab

Disabled on 2026-10-19: its reports had no reader. The 2026-09-21 to
2026-10-19 reports stay in `/var/lib/ophis-quote-lab/`. When re-enabled, the
timer runs the 10-case Uniswap V2/V3 matrix at minutes 7, 22, 37 and 52 in a
read-only container (128 MiB, 0.25 CPU, three-minute timeout) and keeps 30
days of JSON reports. Build the image on the Mac, then copy it with
`docker save` and `docker load`:

```sh
# From apps/backend on the build machine:
docker buildx build --platform linux/amd64 --load \
  -t local/ophis-quote-lab:20260921 \
  -f ../../infra/ethereum-rpc/Dockerfile.quote-lab .

# On cadia-wsl:
sudo install -m 644 /srv/ophis/infra/ethereum-rpc/ophis-quote-lab.service /etc/systemd/system/
sudo install -m 644 /srv/ophis/infra/ethereum-rpc/ophis-quote-lab.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now ophis-quote-lab.timer
```

Rollback: `sudo systemctl disable --now ophis-quote-lab.timer`.

## 4. Robinhood parent-chain reads

Nitro accepts one `--parent-chain.connection.url` and has no failover, so it
reads Ethereum through `l1-execution-proxy`, part of the base Compose stack in
`infra/robinhood-mainnet/nitro/`. The proxy tries `L1_PRIMARY_UPSTREAM` first,
then public dRPC for general reads and serialized MEV Blocker calls for log
ranges. Each fallback prints one `l1-proxy: primary miss` line. An explicitly
empty `L1_PRIMARY_UPSTREAM` disables baal. Beacon and blob settings stay
separate (`L1_BEACON_URL` plus the blob archive adapter).

The live directory `/home/clement/robinhood-nitro` is not a checkout; merge
changes into it by hand, keep its `.env`, and recreate Nitro only when its
effective settings change. Run `verify-snapshot.sh` with
`L1_RPC=http://100.69.134.7:8547` directly: the proxy refuses log ranges over
10,000 blocks.

## Development

From a Mac on the tailnet (Tailscale connected):

| Task | Setting |
| --- | --- |
| Frontend dev server | `REACT_APP_NETWORK_URL_1=http://100.69.134.7:8547` in `apps/frontend/.env.serve.local`, then restart. Never `.env.local`: builds read it. |
| Backend playground (mainnet fork) | `ETH_RPC_URL=http://100.69.134.7:8547` in `apps/backend/playground/.env`; full reset at least every 30 h |
| anvil | `anvil --fork-url http://100.69.134.7:8547`, no block pin (or one within the last 10,000 blocks) |
| Contracts fork tests | `OPHIS_FORK_RPC_ETH=http://100.69.134.7:8547` (vault preflight, safe-swap `test:fork`); `MAINNET_RPC_URL=…` for `AcrossMathHelper.t.sol` |
| OTC fork suite | `FOUNDRY_PROFILE=otc-fork forge test --fork-url http://100.69.134.7:8547 --match-path test/otc-fork/OtcSwapboardEthereumFork.t.sol` |
| Ignored backend tests | `NODE_URL=http://100.69.134.7:8547 NODE_WS_URL=ws://100.69.134.7:8548` per command (Hardhat applies `NODE_URL` to every network) |
| Quote Lab | `ETHEREUM_RPC_URL=http://100.69.134.7:8547` |
| Rebate indexer, local | `SETTLE_RPC_URL_1=http://100.69.134.7:8547 pnpm dev` |
| Swap reconciliation | `SCAN_RPC_ETHEREUM=http://100.69.134.7:8547 SCAN_BLOCK_RPC_ETHEREUM=https://eth.drpc.org pnpm scan …` (the block search starts below baal's history) |
| cast | `ETH_RPC_URL=http://100.69.134.7:8547` |

## Not for baal

- The forked e2e tests (`FORK_URL_MAINNET`): they pin blocks 20.4M-24.9M and
  need archive state.
- Anything that needs `debug_*` or `trace_*` (the balance-override detector
  test, Otterscan traces in the playground).
- The Ophis CLI: `OPHIS_RPC_URL_1` accepts only https or localhost URLs.
- Blob or beacon data for rollup nodes.
- Anything executed in a browser, on Cloudflare or on GitHub-hosted runners.

## Local checks

```sh
uv run --no-project python infra/robinhood-mainnet/nitro/test_l1_execution_proxy.py
uv run --no-project python infra/ethereum-rpc/test_quote_lab_runner.py
uv run --no-project python infra/ethereum-rpc/test_notify_otc_canary.py
pnpm --filter @ophis/rebate-indexer exec vitest run tests/rpcClient.test.ts
node scripts/otc-mainnet-canary.mjs --self-test
OTC_CANARY_RPC_URL=http://100.69.134.7:8547 node scripts/otc-mainnet-canary.mjs
```
