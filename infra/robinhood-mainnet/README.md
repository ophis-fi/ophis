# Ophis - Robinhood Chain Mainnet Operator Runbook

This stack runs the Ophis deployment on **Robinhood Chain mainnet (chain 4663)**, an
**Arbitrum Orbit L2**. It serves user intents, runs a solver auction, and settles
through the sovereign `GPv2Settlement` deployed on Robinhood. The production
deployment runs on Cadia and its security-sensitive configuration fails closed.

## Deployed state

- `GPv2Settlement`: `0x886d9fd312F442C4E1f3cdeAE7b4AB73493e57cD`
- `GPv2VaultRelayer`: `0xB52C38097c19cd38238c62DD36027a7918eFa890`
- `GPv2AllowListAuthentication`: `0x5c802B14d9E132717aE78D42B19a4c517876F2E7`
- Protocol Safe: `0xe049a64546fb8564CC4c7D64A0A1BAe00Aa801cF`
- Active allowlisted submitter: `0x95f0beaB29BeA3D18A7c81140AED9227Ff2D7665`

The sovereign contracts were deployed on 2026-07-25 and protocol authority is
held by the 2-of-3 Safe. Cadia runs the stack and the self-hosted Nitro node at
`ophis-rbh-node:8547`; the node must remain synced with `debug,arb,arbtrace`
enabled because the autopilot requires `debug_traceTransaction`.

---

## Stack Overview

| Component     | Port (host) | Description |
|---------------|-------------|-------------|
| orderbook     | 8410        | REST API - order creation, quotes, status |
| driver        | 8411        | Solver engine + settlement submitter |
| baseline      | 9310        | On-chain liquidity solver - ships EMPTY (Robinhood liquidity is Uniswap V4) |
| lifi-solver   | 9311        | LI.FI same-chain aggregator - the ONLY supported lane on 4663 today |
| rpc-proxy     | 4003        | 2-of-2 read consensus + transaction relay (chain 4663) |
| prometheus    | 9096        | Metrics (observability profile) |
| alertmanager  | 9097        | Telegram alerts (observability profile) |
| jaeger UI     | 16688       | Distributed tracing |
| postgres      | 5440        | Database |

Chain: **4663 (Robinhood)**, ~134ms blocks. Domain: **robinhood-mainnet.ophis.fi**.
eRPC endpoint: `http://rpc-proxy:4000/main/evm/4663`.

Native ETH sells use the ownerless Ophis ETH Flow contract
`0xC1Ee77e8a1B85D5EED702a9bB435f434408A4d29`, deployed at block
`21,574,754` on 2026-07-28 and constructor-wired to the sovereign Settlement
and Robinhood WETH.

---

## Production invariants

- **GATE (node):** self-hosted Nitro node synced + `debug_traceTransaction` trace-verified
  on a recent tx (see `nitro/README.md`). Without it the autopilot pauses settlement.
- **RPC availability:** protected reads require agreement between Cadia Nitro
  and Robinhood's official public RPC. Traces remain Cadia-only. An outage fails closed;
  true trace high availability requires a second independently hosted Nitro node.
- **GATE (native pricing):** confirm CoinGecko lists chain 4663 (a 1-day-old chain usually
  is not) AND/OR that Uniswap V3 pools on 4663 hold real depth. See the native-pricing GATE
  in `configs/orderbook.toml.tmpl`. If neither holds, a custom V4 native-price source is
  needed. Per the 2026-07-02 audit, do not trust a shallow V3 TWAP for fee/rebate valuation.
- **LiFi router allowlist:** on 4663 LiFi's router is
  `0xB477751B76CF82d00a686A1232f5fCD772414Af3`, NOT the usual LiFiDiamond. Add it to
  `dex::lifi::LIFI_ROUTER_ALLOWLIST` AND `driver custom_allowlist::ROBINHOOD_MAINNET`, or
  every quote fails the same-chain safety check. See `configs/lifi.toml.tmpl`.
- **Chain wiring:** chain 4663 is wired into the backend and solver chain enums.
  The frontend, Safe app, compatibility API, MCP server, and `@ophis/sdk` must
  retain their checked Robinhood URL and deployed-contract mappings.

---

## First Start (after the gates above are cleared)

```bash
# 1. Bring up the Nitro node (separate project) and trace-verify it.
cd infra/robinhood-mainnet/nitro && cp .env.example .env  # fill L1 endpoints
docker compose up -d          # see nitro/README.md for the trace check

# 2. Bring up the main stack.
cd infra/robinhood-mainnet
cp .env.example .env          # fill secrets, chmod 600
# fill every __FILL_AFTER_DEPLOY_*__ in configs/*.toml.tmpl (see FILL-IN-AFTER-DEPLOY.md)
./render-configs.sh           # renders *.tmpl -> rendered/* (PK on RAM-disk)
./compose-up.sh               # brings up the full stack
docker compose ps             # verify all services healthy
```

## eRPC Upstreams

The autopilot needs `debug_traceTransaction`, which the public RPC does not serve.
The self-hosted **Nitro** node supplies traces while protected reads use 2-of-2
agreement with Robinhood's official public RPC. Nitro forwards submitted
transactions to that gateway. If either read voter or the trace node is down,
settlement pauses. CI locks this topology through `assert-erpc-failclosed.py`.

## Solver Status

| Solver     | 4663 support | Status |
|------------|--------------|--------|
| lifi       | Confirmed (li.quest lists 4663; live same-chain quote via Fly.trade/Rialto) | **Active - the day-1 lane** |
| baseline   | n/a - ships empty (Robinhood is Uniswap V4) | Inactive |
| kyberswap / okx / velora / odos / openocean / dodo / enso | NOT on 4663 today | Disabled - revisit as each adds the chain |

Single-lane (LiFi) at first means no competitive auction, so surplus is thin until a second
solver joins. Planned 2nd lane: a self-run **Uniswap V4 dex-solver** (V4Quoter +
UniversalRouter), reporting the router slippage-floor as clearing price (sole-solver chains
zero the auction on an optimistic bid - the Unichain native-buy lesson).

## Common Failures

**Autopilot stops settling / `debug_traceTransaction` errors:** the Nitro self-node is the
only trace source. Confirm it is at the tip, `debug,arb,arbtrace` are in `--http.api`, and
both L1 legs (execution + beacon) are up. Node down => settlement paused by design.

**Stack won't start - placeholder errors:** every `__FILL_AFTER_DEPLOY_*__` must be replaced
with a real address (see `FILL-IN-AFTER-DEPLOY.md`); `render-configs.sh` fails closed on any
remaining placeholder.

**Database port conflict:** this stack uses **5440**. On its own dedicated VM this should not
collide; if co-located with OP/Unichain, edit `docker-compose.yml`.
