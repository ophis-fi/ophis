# Ophis - Robinhood Chain Mainnet Operator Runbook

This stack runs the Ophis deployment on **Robinhood Chain mainnet (chain 4663)**, an
**Arbitrum Orbit L2**. It serves user intents, runs a solver auction, and settles
through the sovereign `GPv2Settlement` deployed on Robinhood. This is a **draft
scaffold**: several gates below MUST be cleared before it can carry real volume.

**SCAFFOLD STATUS - not yet deployable.** Open items are flagged inline as `GATE:`.

## Two hard prerequisites (same shape as Unichain, different internals)

1. **Sovereign contracts are not deployed yet.** The GPv2 core + 2-of-3 Safe governance
   ceremony must run first. The on-chain foundation is ready (verified 2026-07-02): the
   CREATE2 deployer `0x4e59b44847...B4956C`, Safe 1.3.0 + 1.4.1 factories/singletons, and
   canonical WETH9 `0x0Bd7D308...cAD73` are all present, so the Unichain deploy ceremony
   transfers with Orbit gas adjustments. See `FILL-IN-AFTER-DEPLOY.md`. (The ceremony
   script itself - `deploy/` - is the next deliverable after this scaffold.)
2. **A self-hosted Nitro node must be reachable** at `ophis-rbh-node:8547` over Tailscale,
   with `debug,arb,arbtrace` enabled. The autopilot HARD-requires `debug_traceTransaction`
   and the public RPC does not serve it. See **`nitro/README.md`** - this is the biggest
   lift and the main divergence from the OP-Stack playbook.

---

## Stack Overview

| Component     | Port (host) | Description |
|---------------|-------------|-------------|
| orderbook     | 8410        | REST API - order creation, quotes, status |
| driver        | 8411        | Solver engine + settlement submitter |
| baseline      | 9310        | On-chain liquidity solver - ships EMPTY (Robinhood liquidity is Uniswap V4) |
| lifi-solver   | 9311        | LI.FI same-chain aggregator - the ONLY supported lane on 4663 today |
| rpc-proxy     | 4003        | eRPC 3-of-4 consensus proxy (chain 4663) |
| prometheus    | 9096        | Metrics (observability profile) |
| alertmanager  | 9097        | Telegram alerts (observability profile) |
| jaeger UI     | 16688       | Distributed tracing |
| postgres      | 5440        | Database |

Chain: **4663 (Robinhood)**, ~134ms blocks. Domain: **robinhood-mainnet.ophis.fi**.
eRPC endpoint: `http://rpc-proxy:4000/main/evm/4663`.

---

## Gates to clear before go-live

- **GATE (node):** self-hosted Nitro node synced + `debug_traceTransaction` trace-verified
  on a recent tx (see `nitro/README.md`). Without it the autopilot pauses settlement.
- **GATE (RPC independence) — RESOLVED (Chainstack added 2026-07-23):** the 4 eRPC upstreams
  are self-node + Chainstack + Robinhood-public + Alchemy. Robinhood-public is
  Alchemy-provisioned, so `{public, alchemy}` may share a failure domain, but Chainstack is a
  third independent read voter and `agreementThreshold:3` stops that correlated pair reaching
  consensus alone. A 2nd independent Nitro node would still add *trace* redundancy (see the
  trace-redundancy DESIGN NOTE in `configs/erpc.yaml.tmpl`).
- **GATE (native pricing):** confirm CoinGecko lists chain 4663 (a 1-day-old chain usually
  is not) AND/OR that Uniswap V3 pools on 4663 hold real depth. See the native-pricing GATE
  in `configs/orderbook.toml.tmpl`. If neither holds, a custom V4 native-price source is
  needed. Per the 2026-07-02 audit, do not trust a shallow V3 TWAP for fee/rebate valuation.
- **GATE (LiFi router allowlist):** on 4663 LiFi's router is
  `0xB477751B76CF82d00a686A1232f5fCD772414Af3`, NOT the usual LiFiDiamond. Add it to
  `dex::lifi::LIFI_ROUTER_ALLOWLIST` AND `driver custom_allowlist::ROBINHOOD_MAINNET`, or
  every quote fails the same-chain safety check. See `configs/lifi.toml.tmpl`.
- **GATE (backend chain wiring):** chain 4663 must be added to the backend `Chain` enum
  (`apps/backend/crates/chain/src/lib.rs`, block_time 100ms) and the solvers `ChainId` enum,
  plus the frontend / @ophis/sdk / rebate-indexer touch-points. See the port checklist in
  memory (`2026-07-02-robinhood-chain-port-research.md`). This scaffold is the infra layer only.

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

Like Unichain, the autopilot needs `debug_traceTransaction`, which the public RPC does not
serve - so the self-hosted **Nitro** node is the only `debug`/`arbtrace` leg, plus a read
voter, alongside three read legs (Chainstack — independent — plus Robinhood-public and
Alchemy). Reads use 3-of-4 consensus; `debug_`/`arbtrace_`
route only to the self-node. If the self-node is down, trace fails closed and the autopilot
pauses settlement (safe). The fail-closed invariants are enforced by
`assert-erpc-failclosed.py` in CI (chain 4663). See the RPC-independence GATE above.

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
