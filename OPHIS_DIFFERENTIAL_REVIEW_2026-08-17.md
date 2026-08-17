# Ophis differential security review

## Executive Summary

The local Trail of Bits differential-review methodology was applied to the
cumulative branch and worktree diff against `origin/main`, with a surgical
review of the three authorized security boundaries: wallet capability safety,
token-policy enforcement, and Ethereum recipient-name resolution.

No open critical or high-severity finding remains in those boundaries. Four
medium findings identified during review were fixed and regression-tested. The
review does not authorize deployment, does not cover a new execution venue, and
is not a human audit or an endorsement by Trail of Bits.

The cumulative diff is broad: 291 files, 10,813 insertions, and 2,571 deletions
at the time of review. Most of that surface predates or is mechanically related
to the three features. This review therefore used a surgical strategy centered
on trust boundaries, signing and submission sinks, parsing, retry behavior,
and recipient integrity. Reducing unrelated diff noise before a production
review remains strongly recommended.

## What Changed

### Wallet capability safety

- Capability responses are bound to the selected chain and ambiguous entries
  fail closed.
- `wallet_sendCalls` requests require version `2.0.0`, atomic execution, a
  nonzero account, nonzero targets, direct calls, valid byte calldata, and
  bounded unsigned values.
- Batch identifiers and status responses are parsed as untrusted wallet data.
- Confirmation requires successful receipts; terminal failure receipts are
  checked before a stepped retry is considered safe.

Primary implementation:

- `apps/frontend/libs/wallet/src/api/pure/walletCapabilities.ts:146`
- `apps/frontend/libs/wallet/src/api/pure/walletCapabilities.ts:177`
- `apps/frontend/libs/wallet/src/api/pure/walletCapabilities.ts:190`
- `apps/frontend/libs/wallet/src/api/pure/walletCapabilities.ts:226`
- `apps/frontend/libs/wallet/src/api/hooks/useSendBatchTransactions.ts:14`

### Token-policy enforcement

- An allowlist-only policy permits native ETH, WETH, USDC, and DAI on Ethereum
  mainnet.
- Unknown chains, malformed assets, and all unreviewed tokens fail closed.
- The policy is checked at selection and quote surfaces and repeated at signing
  or submission sinks, including regular, safe-bundle, limit, TWAP, and basket
  flows.

Primary implementation:

- `apps/frontend/libs/tokens/src/services/tokenPolicy.ts:18`
- `apps/frontend/libs/tokens/src/services/tokenPolicy.ts:27`
- `apps/frontend/libs/tokens/src/services/tokenPolicy.ts:54`
- `apps/frontend/apps/cowswap-frontend/src/modules/multiOrder/hooks/useBasketPlacement.ts:51`
- `apps/frontend/apps/cowswap-frontend/src/modules/multiOrder/hooks/useBasketPlacement.ts:113`

### Ethereum recipient-name resolution

- Direct addresses remain supported.
- Only normalized `.eth` and second-level `.wei` names are accepted.
- Registry runtime hashes are pinned and verified before reads.
- Zero-address results fail closed, ENS resolvers must contain code, and names
  are resolved again immediately before signing or safe submission.
- Resolution is read-only and restricted to Ethereum mainnet in the UI flow.

Primary implementation:

- `apps/frontend/libs/ens/src/services/ophisNameResolution.ts:78`
- `apps/frontend/libs/ens/src/services/ophisNameResolution.ts:100`
- `apps/frontend/libs/ens/src/services/ophisNameResolution.ts:115`
- `apps/frontend/libs/ens/src/services/ophisNameResolution.ts:134`
- `apps/frontend/libs/ens/src/services/ophisNameResolution.ts:170`
- `apps/frontend/apps/cowswap-frontend/src/common/hooks/useVerifyOphisRecipientName.ts:17`

## Critical Findings

No open critical or high-severity finding was identified in the reviewed
security boundaries.

### M-01 — Non-standard batch identifiers could break status reconciliation

**Status:** Resolved

The first status parser required the wallet to echo a batch identifier even
though the status response need not contain it. That would reject a compliant
response and leave reconciliation stuck. The parser now binds a response with
no identifier to the already validated request identifier and rejects only a
conflicting identifier.

Evidence:

- `apps/frontend/libs/wallet/src/api/pure/walletCapabilities.ts:190`
- `apps/frontend/libs/wallet/src/api/pure/walletCapabilities.spec.ts:62`

### M-02 — Ambiguous receipt states could permit an unsafe stepped retry

**Status:** Resolved

A terminal code alone is insufficient evidence that a batch had no successful
effects. The parser now rejects a confirmed state without successful receipts,
an off-chain failure carrying receipts, and a chain failure carrying any
successful receipt. Pending, confirmed, partial, and unknown states remain
non-retryable.

Evidence:

- `apps/frontend/libs/wallet/src/api/pure/walletCapabilities.ts:204`
- `apps/frontend/libs/wallet/src/api/pure/walletCapabilities.ts:221`
- `apps/frontend/libs/wallet/src/api/pure/walletCapabilities.spec.ts:86`
- `apps/frontend/libs/wallet/src/api/pure/walletCapabilities.spec.ts:121`

### M-03 — Batch construction accepted insufficiently constrained call data

**Status:** Resolved

Untrusted or malformed calls could previously reach the wallet provider with
weak validation. Construction now rejects empty batches, zero accounts and
targets, delegate-call operations, malformed byte strings, negative or padded
numeric strings, and values above `uint256`.

Evidence:

- `apps/frontend/libs/wallet/src/api/pure/walletCapabilities.ts:226`
- `apps/frontend/libs/wallet/src/api/pure/walletCapabilities.spec.ts:144`

### M-04 — Basket placement was a future token-policy bypass sink

**Status:** Resolved

Token selection and ordinary trade submission were protected, but the exported
basket placement hook was also a signing/submission boundary. A caller reaching
that hook with constructed state could bypass UI checks. Every basket leg is
now asserted against the token policy immediately before placement begins.

Evidence:

- `apps/frontend/apps/cowswap-frontend/src/modules/multiOrder/hooks/useBasketPlacement.ts:51`
- `apps/frontend/apps/cowswap-frontend/src/modules/multiOrder/hooks/useBasketPlacement.ts:113`
- `apps/frontend/libs/tokens/src/services/tokenPolicy.spec.ts:41`

## Test Coverage

- Repository test target: 27 of 27 projects passed.
- Frontend Jest target: 160 suites, 1,263 tests, and 8 snapshots passed.
- Wallet library: 19 tests passed.
- Token library: 75 tests passed.
- Name library: 5 tests passed.
- Landing application: build, 57 unit tests, 15 CSP tests, and 69 browser
  tests passed.
- Repository lint target: 27 of 27 projects passed with zero errors. Existing
  warning-level architectural and formatting debt remains visible because the
  repository does not configure warnings as failures.
- Frontend TypeScript target passed.

The name tests use deterministic reader doubles. They validate normalization,
registry selection, integrity-hash failure, direct-address behavior, and
pre-sign re-resolution. They do not replace a fork test against live Ethereum
state.

## Blast Radius

Static reference tracing found:

- 9 wallet capability or batch-status files;
- 13 token-policy files; and
- 12 recipient-name files.

The highest-impact downstream consumers are order signing, safe submission,
limit and TWAP creation, basket placement, recipient validation, and wallet
batch reconciliation. Failure modes are deliberately fail-closed: a policy or
integrity failure prevents the action instead of falling back to an unreviewed
path.

No Solidity file differs from `origin/main`, so this differential cannot alter
deployed bytecode. No execution integration was added.

## Historical Context

History inspection identified the branch foundations and prior wallet hardening
in commits `e6b61466` and `66c57c92`. Earlier basket work introduced the batch
call surface in commit `240e7363`. The token-policy and name-resolution service
files are new in the current worktree and therefore have no earlier blame or
fix history.

The review compared current callers with those historical entry points to find
new trust-boundary crossings rather than treating the new helpers in isolation.

## Recommendations

1. Keep deployment locked until the user approves the exact final diff.
2. Before production, run a mainnet-fork recipient-resolution test that verifies
   the pinned registry bytecode and representative names at a fixed block.
3. Add a CI rule that fails if a new order-signing or submission sink does not
   call the central token policy.
4. Keep the token allowlist intentionally small. Each added asset and each new
   chain needs a separate behavior review.
5. Preserve the rule that uncertain wallet batches are reconciled, never
   automatically replayed.
6. Split or revert unrelated mechanical changes before a human production
   review so reviewers can reason about a smaller semantic diff.
7. Treat existing lint warnings as tracked debt. They do not make the current
   configured lint command fail, but zero errors is not the same as warning-free.

## Methodology

The review followed the locally installed Trail of Bits differential-review and
context-building instructions:

1. establish the merge base and cumulative working-tree scope;
2. inventory changed files and security-sensitive entry points;
3. trace untrusted data from wallets, token state, and name registries to
   signing or submission sinks;
4. inspect caller and callee context rather than isolated diff hunks;
5. review relevant history with `git log` and pickaxe searches;
6. enumerate downstream consumers and fail-open/fail-closed behavior;
7. add adversarial regression tests for each confirmed issue; and
8. rerun project and repository-wide verification after remediation.

The large cumulative diff required a surgical review strategy. This report
does not claim exhaustive semantic review of every mechanically changed UI
file.

## Appendices

### Review scope

- Repository: `/Users/scep/ophis-priority-lab`
- Base: `origin/main` at `dce09b13`
- Reviewed branch: `codex/ophis-priority-lab`, including the resolved merge result
- Worktree: included in the final verification run
- Solidity differential: none

### Formal and specialist gate boundaries

- Verity: `lake build Contracts.AllowListGuardian` passed in the local proof
  workspace with two unused-variable warnings. The proof target is an existing
  Solidity model and does not prove the TypeScript features reviewed here.
- Pashov Solidity workflow: not applicable because the cumulative diff contains
  no Solidity. No Pashov approval is claimed for TypeScript.
- Trail of Bits: this report applies the installed methodology locally. It is
  not a human Trail of Bits audit or endorsement.

### Deployment status

The review branch was pushed and opened as a draft pull request. No release was
created and no deployment was performed.
