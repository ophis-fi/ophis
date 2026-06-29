# Unichain stack — end-to-end VALIDATION gate

> Nothing in `infra/unichain-mainnet/` gets committed as "working" until EVERY gate
> below passes against the REAL node + deployed contracts + funded EOA. Static
> checks (config parses, no Base residue, eRPC guard) are necessary but NOT proof.
> Run top to bottom; a failed gate blocks the next.

## Prereqs (must all exist first)
- [x] **WS13** Unichain op-reth node up on the Aleph VM (root@51.158.205.9:24005). Synced to tip, trace-verified (Gate 1).
- [x] **WS3** GPv2 contracts deployed on 130 (2026-06-29 Ledger ceremony); every `__FILL_AFTER_DEPLOY_*__` replaced in `configs/` (ETHFLOW deferred). Governance handed to 2-of-3 Safe `0xe049a64…01cF`. See FILL-IN-AFTER-DEPLOY.md for the address table.
- [x] **WS10** submitter EOA `0x7A956C26…f3fBb` created (PK at `/opt/ophis-submitter/submitter.json` on the VM), allowlisted on the Unichain Authenticator (`isSolver` == true). Funding on 130 confirmed at ceremony.

## Gate 1 — the node (WS13)
```
cast chain-id   --rpc-url http://ophis-uni-node:8545     # expect 130
cast block-number --rpc-url http://ophis-uni-node:8545   # within a few blocks of uniscan tip
# trace works (the autopilot hard-req):
cast rpc debug_traceTransaction <recent_uni_tx> '{"tracer":"callTracer"}' --rpc-url http://ophis-uni-node:8545
```
- [ ] chainId 130, synced to tip, `debug_traceTransaction(callTracer)` returns a call frame.
- [ ] op-reth = v2.3.1, op-node = v1.19.0 (Karst-ready before 2026-07-08 16:00 UTC).
- [ ] datadir on the 500 GB block-storage volume; docker log rotation + disk alert configured.

## Gate 2 — static config (no node needed; already partially done)
```
cd infra/unichain-mainnet
uv run --with pyyaml python3 assert-erpc-failclosed.py configs/erpc.yaml.tmpl   # PASS
grep -rnE "8453|base\.org|base\.gateway|0x833589|BASE_MAINNET_RPC|BASE_RPC_INTERNAL" configs/  # empty
grep -rn "__FILL_AFTER_DEPLOY" configs/    # empty AFTER WS3 fill
```
- [ ] eRPC fail-closed guard passes.
- [x] zero Base addresses/hosts; zero unresolved placeholders (WS3/WS10 fills applied 2026-06-29; `grep -rn __FILL_AFTER_DEPLOY configs/` clean).
- [x] **baseline-liquidity strip done** (no Base v2/v3/Balancer/Sushi routers; Unichain baseline = empty, v4 via the aggregators). *(DONE 2026-06-25: both UniV2/Sushi routers had ZERO code on chain 130, verified via eth_getCode against the live node; stripped to KyberSwap-only. OKX staged consistently across driver/autopilot/orderbook; OP submitter EOA replaced by `__FILL_AFTER_DEPLOY_SUBMITTER__`. Codex gpt-5.5 verified.)*

## Gate 3 — render + boot
```
./render-configs.sh        # exits 0, refuses on leftover BASE_/OP_ bypass vars
./compose-up.sh
docker compose ps          # every service Healthy; migrations exited 0
```
- [ ] render clean, all containers healthy, Flyway migrations passed.

## Gate 4 — eRPC reaches the chain
```
curl -s http://127.0.0.1:4002/main/evm/130 -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}'   # 0x82
# consensus holds (no sustained disputes):
docker compose logs rpc-proxy | grep -c dispute   # transient only, not sustained
# debug routes to the self-node (public legs don't serve it):
curl -s http://127.0.0.1:4002/main/evm/130 -d '{"jsonrpc":"2.0","id":1,"method":"debug_traceTransaction","params":["<tx>",{"tracer":"callTracer"}]}'  # returns a trace
```
- [ ] reads consensus 2-of-3; `debug_traceTransaction` succeeds (via the self-node).

## Gate 5 — orderbook quotes (KyberSwap v4)
```
curl -s http://127.0.0.1:8400/api/v1/quote -d '{ "sellToken":"0x078d782b...USDC", "buyToken":"0x4200...WETH", "sellAmountBeforeFee":"1000000000", ... }'
```
- [ ] a quote returns, routed via the KyberSwap solver (a real Uniswap-v4 route on 130).

## Gate 6 — a real settlement end-to-end (the proof)
- [ ] place ONE tiny real order; the driver submits; it settles on 130 in `GPv2Settlement`.
- [ ] the autopilot processes it (the `debug_traceTransaction` path runs, no missing-trace).
- [ ] the Ophis partner fee is retained in Settlement (appData partnerFee enforced).
- [ ] rebate-indexer (if wired) attributes it.

## Only AFTER all 6 gates pass
- commit the scaffold (its own branch off main) as VERIFIED.
- flip the frontend `cowSdk.ts` URL to `unichain-mainnet.ophis.fi` (held until here).

## GOVERNANCE BLOCKER (dated — Codex MEDIUM, 2026-06-26)
WS3 launches DIRECT-TO-SAFE (2-of-3 Safe owns + manages AllowListAuthentication), NOT
the OP 24h TimelockController + AllowListGuardian. Acceptable for Phase-0 (single-solver,
low TVL), but the Safe can instantly addSolver/upgrade. **Before meaningful TVL OR the
public `cowSdk.ts` frontend flip**, deploy the per-chain 24h Timelock + AllowListGuardian
(`contracts/src/contracts/AllowListGuardian.sol`) and migrate Auth ownership/manager to
them (the OP post-launch model). Until then, keep traffic gated. Do NOT flip `cowSdk.ts`
public while still direct-to-Safe with non-trivial TVL.

---
### Static work status (2026-06-25 — Gate 2 DONE, Codex gpt-5.5 verified)
- baseline-liquidity strip: DONE (both UniV2/Sushi routers had zero code on 130; baseline empty, KyberSwap-only).
- OP submitter EOA `0x92B9…`: DONE (now `__FILL_AFTER_DEPLOY_SUBMITTER__`, filled at WS10; render-configs.sh now refuses any unfilled `__FILL_AFTER_DEPLOY_*__` on the .tmpl source).
- Base DeFi prose / basescan.org / Aerodrome: DONE (removed/rewritten).
- OKX: staged consistently (commented in driver + autopilot + orderbook; re-enable all three + the okx-solver service together).
- README RPC + solver tables: done. eRPC self-node redesign: done + guard-green + LIVE-validated against the node (chainId 130, 2-of-3 consensus, debug_traceTransaction routes to the self-node).
- REMAINING (NOT Gate 2): Gate 3 stack images must be BUILT from the WS1 branch (chain 130 enum, `feat/unichain-130-enable-kyberswap`); WS3 contract fills; WS10 submitter EOA fill.
