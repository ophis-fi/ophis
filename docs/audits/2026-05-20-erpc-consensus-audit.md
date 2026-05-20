# eRPC consensus mitigation audit — deferred findings

**Audited by:** Codex CLI 0.130.0 + sharp-edges-analyzer agent (parallel)
**Date:** 2026-05-20 post-Phase-3.1 incident
**Status:** 1 HIGH + 4 MED applied below; 1 HIGH + 2 MED **DEFERRED** (require infrastructure not yet in place)

## Background

During Phase 3.1 (first real OP mainnet swap), the eRPC's 2-of-3 strict
consensus on `eth_call|eth_getBalance|eth_estimateGas|eth_feeHistory`
DoS'd the driver under partial-failure (Tenderly free-tier rate limit
+ container-unreachable self-hosted node). Emergency mitigation: moved
those four methods from strict consensus to retry-only. Documented in
`infra/optimism-mainnet/configs/erpc.yaml.tmpl`.

Audit ran post-deploy on the four session deltas:

- `infra/optimism-mainnet/configs/erpc.yaml.tmpl` (the eRPC change)
- `apps/frontend/apps/cowswap-frontend/src/legacy/components/TransactionConfirmationModal/DisplayLink.tsx` (FE link fix)
- `infra/optimism-mainnet/scripts/verify-e2e-swap.sh` (E2E harness)
- `apps/frontend/scripts/deploy-ophis.sh` (deploy wrapper)

## Findings applied in this PR

| ID | Severity | File | Issue | Fix |
|---|---|---|---|---|
| F1 | MED | DisplayLink.tsx | `OPHIS_FORK_CHAINS = [10]` is deny-list-by-omission — adding a new Ophis chain (MegaETH, HyperEVM, etc) without updating regresses to the owner-address-redirect bug. | Inverted to allow-list `CHAINS_WITH_COW_ORDER_EXPLORER` of chains that have a working CoW order explorer. New chains default-safe. |
| F2 | MED | verify-e2e-swap.sh | `--owner` / `--from-block` / `--timeout` / `OPHIS_RPC` unvalidated — malformed input produces silent false-negatives via bogus topic encoding. | Added regex validation upfront for all 4 args. |
| F3 | HIGH | deploy-ophis.sh | `STAGE=${OPHIS_DEPLOY_STAGE:-/tmp/ophis-deploy-stage}` + `rm -rf "$STAGE"` is dangerous if env-var is `/`, `$HOME`, repo root, or any non-tmp path. | Default to `mktemp -d`; if user override provided, validate it's under `/tmp` or `/var/folders` AND not a sensitive path. Belt-and-suspenders check before `rm -rf`. |
| F4 | MED | deploy-ophis.sh | `CLOUDFLARE_API_TOKEN` stays exported after wrangler returns, leaking to post-deploy curl checks via env. | `unset CLOUDFLARE_API_TOKEN` immediately after wrangler. |
| F5 | MED | deploy-ophis.sh | `curl https://ophis.fi` may return gzipped body, breaking grep extraction → empty BUNDLE_HASH printed as success. | Added `--compressed` flag + empty-check warning. |

## Findings DEFERRED — require infrastructure work first

### F6 — `eth_call` in retry-only path (HIGH/sharp-edges, MED/codex)

**Why deferred:** restoring `eth_call` to 2-of-3 strict consensus immediately
will re-introduce the Phase 3.1 swap failures. The eRPC bottleneck is real
(tenderly rate-limits, self-hosted unreachable from container). We need at
least 2 reliable upstreams answering before re-enabling consensus.

**Actual risk surface (per audit):**

- A forged `eth_call` from one hostile upstream could **steer the auction
  toward a chosen solver** during winner selection — even though the final
  settlement reverts, the autopilot may credit "would-have-won" objective
  scores into solver rewards.
- A forged `eth_call` against `ERC20.allowance`/`balanceOf` is a free DoS
  vector against any specific user (autopilot filters their order as
  "insufficient balance").
- A forged `eth_call` lets the driver broadcast txs that revert on-chain.
  Gas loss is bounded by the 5 gwei cap (~$0.05/tx) but cumulative if a
  hostile upstream causes repeated reverts.

**Mitigation path (in priority order):**

1. **Land task #112** (container → Tailscale via socat host proxy).
   This restores the self-hosted op-node as a reachable upstream for
   the container, giving us 3 working upstreams. After #112, restore
   `eth_call` to 2-of-3 consensus. Tracked as task #115.
2. **Until then**, accept the risk. Real money lost is bounded by gas
   cap (~$0.05/tx) + non-monetary "wrong solver wins" (which the
   auction's verification step on real settlement still catches).
3. **Optional circuit-breaker**: track simulation-success → on-chain-revert
   correlation, alert if >5 in any 10-min window (suggests upstream
   poisoning). Codex recommended. Filed as task #116.

### F7 — `eth_getTransactionCount` not in consensus (MED/codex)

**Why deferred:** verifying whether the driver uses eRPC for nonce
discovery vs directly hitting its pinned submission-mempool endpoint
requires reading the driver source path. The driver config has 4 pinned
`[[submission.mempool]]` entries (publicnode, self-hosted, mainnet.optimism.io,
tenderly); if nonce is read from those directly, no eRPC consensus risk.

**Action:** spike — confirm driver nonce path. If via eRPC, add
`eth_getTransactionCount` to the consensus method list. Filed as task #117.

### F8 — `eth_blockNumber` consensus and `enforceHighestBlock` (MED/sharp-edges)

`enforceHighestBlock` only catches stale (behind-tip) responses, not
forged-ahead ones. A hostile upstream returning "block 200 ahead" passes
the check and could mis-direct tip-tagged queries.

**Action:** add `eth_blockNumber` to consensus list with explicit policy.
Filed as task #118.

## Recommendation

Ship the 5 applied fixes (F1-F5) immediately. Open tasks #115-#118 for
the deferred items. The deferred eth_call risk is acceptable for current
volume but MUST be closed before any meaningful TVL.

**No code changes here re-introduce risk that wasn't already in prod.**
The eRPC mitigation that's already live (and which this audit is on) is
the actual risk vector — the audit didn't make it worse.
