# Ophis — Unichain Mainnet Operator Runbook

This stack runs the Ophis Protocol deployment on **Unichain mainnet (chain 130)**. It serves user intents submitted via [unichain-mainnet.ophis.fi](https://unichain-mainnet.ophis.fi), runs a solver auction, and settles trades through the sovereign `GPv2Settlement` contract on Unichain.

**Two hard prerequisites before this stack can run:**
1. **Sovereign contracts are not deployed yet (WS3).** See `FILL-IN-AFTER-DEPLOY.md` for the Phase-1 Ledger ceremony checklist before starting.
2. **A self-hosted Unichain op-reth node (WS13) must be reachable** at `ophis-uni-node:8545` over Tailscale. The autopilot HARD-requires `debug_traceTransaction` (settlement decode) and no free public Unichain RPC serves it — the self-node is the only source. It must be Karst-ready (op-reth v2.3.1 + op-node v1.19.0) before the **2026-07-08 16:00 UTC** Karst hardfork or it halts.

**If you're paged at 3am: jump to [Common Failures](#common-failures).**

---

## Stack Overview

| Component     | Port (host) | Description |
|---------------|-------------|-------------|
| orderbook     | 8400        | REST API — order creation, quotes, status |
| driver        | 8401        | Solver engine + settlement submitter |
| baseline      | 9301        | On-chain liquidity solver — **ships empty on Unichain** (v4 routed via aggregators) |
| okx-solver    | 9302        | OKX DEX aggregator (staged — see Solver Status) |
| kyberswap-solver | 9303     | KyberSwap aggregator (the active first-fill connector) |
| velora-solver | 9304        | Velora/ParaSwap — **disabled on Unichain** (no v4 adapter) |
| rpc-proxy     | 4002        | eRPC 2-of-3 consensus proxy (chain 130) |
| prometheus    | 9092        | Metrics (observability profile) |
| alertmanager  | 9095        | Telegram alerts (observability profile) |
| jaeger UI     | 16687       | Distributed tracing (when enabled) |
| postgres      | 5439        | Database |

Chain: **130 (Unichain)**, ~1s blocks
Domain: **unichain-mainnet.ophis.fi**
eRPC endpoint: `http://rpc-proxy:4000/main/evm/130`

---

## Prerequisites

1. Complete the Phase-1 Ledger ceremony (WS3) — see `FILL-IN-AFTER-DEPLOY.md`.
2. Replace every `__FILL_AFTER_DEPLOY_*__` placeholder in `configs/*.toml.tmpl` with the deployed address.
3. The self-hosted op-reth node (WS13) is up, synced, and **trace-verified** (`debug_traceTransaction` returns on a recent tx), reachable at `ophis-uni-node:8545` over Tailscale.
4. Copy `.env.example` to `.env`, fill in credentials.
5. A **funded, Tier-1-isolated submitter EOA for Unichain** — a NEW per-chain EOA, added to the Unichain Authenticator's solver allowlist and funded with ~0.02 ETH on chain 130. Stored at `/Users/ophis-driver/.config/submitter.key` (Tier-1 PK isolation, same scheme as the OP stack).

---

## First Start

```bash
cd infra/unichain-mainnet
./render-configs.sh     # renders *.toml.tmpl → rendered/*.toml (RAM-disk for PK-bearing)
./compose-up.sh         # brings up the full stack
docker compose ps       # verify all services healthy
```

---

## eRPC Upstreams

Unichain diverges from a public-only stack: the autopilot needs `debug_traceTransaction`, which free public Unichain RPCs do not serve. So this stack runs a **self-hosted node as the `debug`/`trace` leg**, alongside two free public **read** legs. Reads use 2-of-3 consensus; `debug_`/`trace_` route only to the self-node (eRPC's unsupported-method failover).

| ID              | Endpoint                       | Role |
|-----------------|--------------------------------|------|
| ophis-self-uni  | ophis-uni-node:8545            | Self-hosted op-reth (WS13) — the ONLY `debug`/`trace` source + a read-consensus voter |
| unichain-public | mainnet.unichain.org           | Unichain Labs public node — reads |
| publicnode-uni  | unichain-rpc.publicnode.com    | PublicNode (independent operator/DNS) — reads |

If the self-node is down, `debug`/`trace` fail-closed and the autopilot **pauses settlement** (safe — it never mis-settles; it just stops processing until the node returns). The fail-closed consensus invariants (2-of-3, `lowParticipants:returnError`) are enforced by `assert-erpc-failclosed.py` in CI. Unichain's ~1s blocks cause more tip-drift than a 2s chain; `preferBlockHeadLeader` breaks those ties without downgrading consensus.

---

## Solver Status

| Solver     | Unichain v4 support | Status |
|------------|---------------------|--------|
| kyberswap  | Confirmed — live v4 routes (USDC→WETH) | **Active — the first-fill connector** |
| okx        | Confirmed — V6, incl. hooked v4 pools | Staged — needs `OKX_*` creds + the chain-130 router/spender added to `OKX_ROUTER_ALLOWLIST` |
| baseline   | n/a — ships empty | Inactive — Unichain v4 liquidity is routed via the aggregators, not the on-chain baseline |
| velora     | **None** — no Uniswap-v4 adapter on any chain | Disabled — do NOT enable for Unichain |

Single-solver (KyberSwap) at first means no competitive auction, so surplus is poor until a second aggregator (OKX) joins. That's an accepted Phase-0 tradeoff.

---

## Common Failures

**Stack won't start — contract placeholder errors:**
All `__FILL_AFTER_DEPLOY_*__` strings must be replaced with real addresses (see `FILL-IN-AFTER-DEPLOY.md`).

**Autopilot stops processing settlements / `debug_traceTransaction` errors:**
The self-node is the only trace source. Check it: `cast block-number --rpc-url http://ophis-uni-node:8545` (is it at the tip?), confirm `debug` is in its `RETH_HTTP_API`, and that op-node is synced. If the node is down, settlement is paused by design — restore the node.

**eRPC consensus disputes:**
Check `docker compose logs rpc-proxy | grep dispute`. Unichain has ~1s blocks; tip-drift between providers is expected. Only sustained disputes (>60 in 10min for Block A) indicate a problem.

**Driver unhealthy:**
```bash
docker inspect unichain-mainnet-driver-1 --format '{{.State.Health.Status}}'
curl -s http://127.0.0.1:8401/healthz
```
Most likely: low ETH balance on the submitter EOA. Top up to ~0.02 ETH on chain 130.

**Database port conflict:**
This stack uses port **5439**. On its own dedicated Aleph VM this should not collide; if co-located, edit `docker-compose.yml`.

---

## Merge Ordering (Frontend)

See `FILL-IN-AFTER-DEPLOY.md` — the `feeRecipient.ts` fix is safe to merge anytime, but the `cowSdk.ts` Unichain flip must NOT ship until the Unichain stack is live and shadow-validated.
