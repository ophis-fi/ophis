# Ophis token-policy scope and chain-selector hotfix differential review

**Date:** 2026-08-17
**Baseline:** `8e7871b4e9644ab400d43d96ce8c262de227fc3b` (`origin/main`)
**Review target:** working tree on `fix/token-policy-scope-chain-alignment`
**Deployment:** Not authorized by this review

## Executive Summary

| Severity | Open findings |
| -------- | ------------: |
| Critical |             0 |
| High     |             0 |
| Medium   |             0 |
| Low      |             0 |

**Overall risk:** Low
**Recommendation:** Approve the hotfix for PR review. Keep deployment behind the owner's explicit approval.

The production regression came from applying a four-asset, Ethereum-only policy to every established token-selection, quote, validation, and submission path. The hotfix introduces two explicit policy profiles:

- `ESTABLISHED_SETTLEMENT` preserves the product's existing supported-chain token universe while still rejecting malformed addresses and unsupported chains.
- `RESTRICTED_EXECUTION` retains the reviewed Ethereum-only ETH/WETH/USDC/DAI allowlist for any future execution path that receives separate approval.

The profile argument is mandatory. Every current caller names its profile at compile time, so a future call site cannot silently inherit the permissive profile. There is no restricted-execution integration in this change.

The chain-selector change is visual only: it fixes the logo column at 28 px and prevents the Robinhood Chain label from wrapping.

## What Changed

| Area                                             | Files | Risk | Effect                                                                                     |
| ------------------------------------------------ | ----: | ---- | ------------------------------------------------------------------------------------------ |
| Token-policy service/API                         |     3 | High | Separates established settlement from restricted execution and makes the profile mandatory |
| Selection, quote, validation, submission callers |    13 | High | Explicitly bind existing product paths to established settlement                           |
| Chain-selector CSS and regression test           |     2 | Low  | Aligns logos and keeps the longest EVM chain label on one line                             |

Implementation and tests before this report: 145 additions and 50 deletions across 18 files. The review covered the changed policy service and all 13 direct frontend callers.

## Baseline Context and Invariants

The baseline policy was added by merge commit `8e7871b4` on 2026-08-17. The policy file did not exist before that feature. History therefore shows no older security fix being reverted: the hotfix narrows a newly introduced availability restriction that was broader than its execution-risk rationale.

The reconstructed invariants are: malformed assets and unsupported chains always fail; established settlement preserves the product's supported token universe; restricted execution remains Ethereum-only and allowlist-only; every current boundary explicitly uses the established profile; TypeScript rejects an omitted profile; and runtime input cannot choose a profile.

## Critical Findings

No open critical, high, or medium finding was identified.

### Resolved during review: permissive default profile

The first hotfix draft defaulted the policy API to established settlement. That would have made a future caller permissive if it forgot to select the restricted profile. The draft was changed before publication:

- `TokenPolicyProfile` is now an exported enum.
- `getTokenPolicyDecision`, `getCurrencyTokenPolicyDecision`, `isTradeAllowedByTokenPolicy`, and `assertTradeTokenPolicy` all require a profile.
- All 13 production callers explicitly pass `TokenPolicyProfile.ESTABLISHED_SETTLEMENT`.

This converts a documentation convention into a compile-time boundary.

## Adversarial Analysis

**Attacker model:** An untrusted user can manipulate URL state, injected widget state, token addresses, wallet state, and ordinary form input. The attacker cannot alter the compiled profile enum supplied by each call site.

| Attempt                                                 | Control reached                             | Result                                                                                                                |
| ------------------------------------------------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Inject malformed address through persisted/widget state | `isAddress` at `tokenPolicy.ts:34`          | Denied as `invalid-token` before any profile branch                                                                   |
| Inject a valid address on an unknown chain              | `isSupportedChainId` at `tokenPolicy.ts:38` | Denied as `chain-not-reviewed` in both profiles                                                                       |
| Omit the profile in a future restricted call site       | Required `TokenPolicyProfile` parameter     | Compile-time failure; an enum must appear in the reviewed diff                                                        |
| Select a non-allowlisted token in the existing product  | Explicit established-settlement profile     | Restores the prior product boundary; unsupported-token state, quote/form checks, and backend validation remain active |

No new router, venue, calldata executor, approval target, or settlement implementation is introduced. A deliberately wrong profile choice remains a code-review concern, not a runtime attacker-controlled path.

## Test Coverage Analysis

| Check                            | Result                                                         |
| -------------------------------- | -------------------------------------------------------------- |
| Token-policy focused suite       | Pass: 21 tests                                                 |
| Complete token-library suite     | Pass: 12 suites, 89 tests                                      |
| Chain-selector CSS regression    | Pass: 2 tests                                                  |
| Trade-form validation regression | Pass: 9 tests                                                  |
| Frontend TypeScript              | Pass                                                           |
| Changed-file ESLint              | Pass with 0 errors; existing warning-level import debt remains |
| Prettier and `git diff --check`  | Pass                                                           |
| Production frontend build        | Pass                                                           |
| Local production-browser check   | Pass                                                           |

The production-browser check confirmed that representative Ethereum tokens (`0G`, `1INCH`, `AAVE`, and `ACU`) are enabled, `AAVE` can be selected, the Robinhood Chain label uses `white-space: nowrap`, its logo uses `flex: 0 0 28px`, and no console error is emitted.

## Blast Radius Analysis

`getTokenPolicyDecision` reaches 13 direct production call sites spanning selection, quotes, form validation, swaps, limit orders, native-token flow, TWAP, and baskets. This is a high-blast-radius validation change, but every current caller uses the same explicit established-settlement enum. The strict profile has no production caller and cannot create an execution path in this hotfix.

## Function Micro-Analysis

### `getTokenPolicyDecision` — `tokenPolicy.ts:33`

**Purpose:** This is the central pure decision function for token-policy classification. It separates universal structural validation from profile-specific authorization so existing settlement and any future restricted execution cannot accidentally share incompatible token assumptions.

**Inputs & assumptions:** `asset.chainId` and `asset.address` are untrusted form/widget state; `profile` is trusted compiled code; `isAddress` validates EVM syntax; `isSupportedChainId` matches the runtime chain set; `getAddressKey` case-normalizes restricted membership.

**Outputs & effects:** Returns one immutable decision; writes no state; emits no event; makes no network/wallet/contract call; rejects malformed assets and unsupported chains before profile handling.

**Block-by-block analysis:**

- Lines 34-36 validate integer chain shape, positivity, and address syntax. This comes first because no profile may authorize malformed identity data. First principle: authorization requires a well-defined asset identity.
- Lines 38-40 bind both profiles to runtime-supported EVM chains. This precedes the established-settlement return so an injected unknown chain cannot inherit support. Why: chain support includes wallet, RPC, currency, and settlement assumptions beyond address syntax.
- Lines 42-44 return approval for established settlement. This branch exists because those routes already have separate token-support and quote validation; the stricter four-asset rule was not designed for them. Why here: it follows universal validation but precedes restricted-only constraints.
- Lines 46-52 enforce Ethereum and allowlist membership for restricted execution. Why: non-standard transfer behavior cannot be inferred from metadata, and no other chain has a reviewed restricted profile.

**Invariants:** malformed assets never pass; unsupported chains never pass; restricted execution never inherits the established result; restricted membership is case-insensitive; the function is deterministic and side-effect free.

**Five Whys / Hows:** Why validate before branching? Because profile selection must never repair invalid identity. Why separate profiles? Because established settlement and restricted execution have different transfer-semantics assumptions. How is accidental inheritance prevented? By a required enum argument. How is restricted membership stable across checksum casing? By `getAddressKey`. How does an unsupported chain fail? Before either profile can approve it.

**Dependencies and risks:** Called through three helper APIs and directly by the token-list container. It depends on address parsing, chain configuration, and address normalization. A stale supported-chain configuration would affect availability, not allow an unknown chain; a mistaken allowlist address would affect only the unused restricted profile; a future wrong profile selection is visible as an enum constant in source review.

### `getCurrencyTokenPolicyDecision` — `tokenPolicy.ts:55`

**Purpose:** This adapter converts a `Currency` into the central asset shape. It ensures native currencies are evaluated through their wrapped address consistently with settlement and quoting.

**Inputs & assumptions:** The currency is constructed by trusted currency classes; `chainId` is numeric; `wrapped.address` is the execution address; the profile is explicit; wrapping does not change the intended chain; the central function remains the sole decision authority.

**Outputs & effects:** Returns the central decision, performs no writes, makes no external call, and preserves the supplied profile unchanged.

**Block analysis:** Line 56 forwards the currency chain and wrapped address. Why: duplicating policy logic here would allow the two entry points to diverge. First principle: one asset identity must yield one decision.

**Five Whys / Hows:** Why use `wrapped.address`? Settlement represents native value through its wrapped execution identity. Why forward the profile unchanged? The adapter must not weaken caller intent. How is divergence prevented? All authorization remains in the central function. How are invalid addresses handled? The central function rejects them. How are side effects avoided? The adapter only constructs an input object and returns a decision.

**Invariants and dependencies:** Native and wrapped representations share policy treatment; no profile default exists; errors are represented as decisions rather than thrown here. It is called by quote/form/selection helpers and depends completely on `getTokenPolicyDecision`.

### `isTradeAllowedByTokenPolicy` — `tokenPolicy.ts:59`

**Purpose:** This pair-level helper answers whether both sides of a trade satisfy the same explicit profile. It is used before quote construction and in form validation.

**Inputs & assumptions:** Either currency may be absent during form construction; both currencies are untrusted user selections; one explicit profile governs both legs; short-circuit evaluation is acceptable; currency wrapping is deterministic.

**Outputs & effects:** Returns `false` for an incomplete pair, returns the conjunction of both decisions otherwise, performs no writes, emits no event, and makes no external call.

**Block analysis:** Line 64 fails closed for incomplete state. Lines 66-69 evaluate both currencies under one profile. Why: mixing profiles between sell and buy assets would defeat pair-level policy consistency. First principle: a trade is permitted only if every transferred asset is permitted.

**Five Whys / Hows:** Why deny incomplete pairs? A quote cannot safely identify both transferred assets. Why require both decisions? Either leg can violate policy. How is profile consistency maintained? One required enum is forwarded to both evaluations. How is short-circuit behavior safe? A `false` result already denies the pair. How are native assets normalized? Through the currency adapter.

**Invariants and dependencies:** No incomplete trade is approved; both legs use the identical profile; one denied leg denies the pair. It depends on the currency adapter and is consumed by quote and validation paths.

### `assertTradeTokenPolicy` — `tokenPolicy.ts:72`

**Purpose:** This sink-level guard converts policy decisions into a hard failure immediately before signing or submission flows. It preserves defense in depth when constructed state bypasses UI selection.

**Inputs & assumptions:** Both assets may originate from persisted or injected state; callers pass a compiled profile constant; throwing aborts the caller before wallet interaction; both decisions should be computed for diagnostic completeness; error text is not used as authorization state.

**Outputs & effects:** Returns void on success, throws on any denied asset, performs no state write, makes no external call, and prevents later signing/submission effects in each caller.

**Block analysis:** Lines 77-78 evaluate both assets under one profile. Lines 80-82 throw if either decision is denied and include both reasons. Why: sink validation must not depend on UI reachability. First principle: no wallet side effect should occur after a policy failure.

**Five Whys / Hows:** Why repeat policy at sinks? Persisted or injected state can bypass selection UI. Why throw instead of return? Submission callers must abort before wallet interaction. How are both legs bound consistently? One profile argument is used twice. How are failures diagnosable? Both reason codes are included. How is replay risk avoided? The guard runs before any submission side effect.

**Invariants and dependencies:** Both legs use one profile; any denial aborts; malformed or unsupported assets cannot reach wallet interaction through these guarded paths. The function is called by swap, Safe, native-token, limit, TWAP, and basket sinks and depends on the central decision function.

## Historical Context

- The global four-asset enforcement was introduced in `8e7871b4` and immediately produced the reported availability regression.
- The hotfix does not remove the reviewed allowlist; it confines it to an explicit restricted profile.
- There is no earlier policy-file history before the merged feature, so no longstanding security validation is being silently reverted.
- The selector layout change has no security-relevant history or execution dependency.

## Recommendations

- Before merge: require green CI for the exact commit and the requested independent review.
- Before deployment: verify the immutable preview on desktop and compact widths, then obtain explicit owner approval.
- Future restricted work: require `RESTRICTED_EXECUTION` at every boundary, add a static check when its first caller is introduced, and expand its allowlist only after chain-specific review.

## Named Review-Gate Applicability

- **Trail of Bits methodology:** The installed differential-review and context-building workflows were applied to the complete hotfix diff. This is a local methodology result, not a human audit or organizational endorsement.
- **Verity Lang:** The repository's Verity models target Solidity contracts. This hotfix changes TypeScript, CSS-in-TypeScript, tests, and documentation only; no Solidity or Lean model changed, so there is no applicable formal proof target and no Verity proof claim is made.
- **Pashov workflow:** The installed Pashov workflow targets Solidity contract source. No `.sol` file changes in this hotfix, so the workflow has no applicable source target and no Pashov approval of TypeScript is claimed.

These applicability results keep deployment locked for owner approval; they must not be presented as third-party endorsements.

## Analysis Methodology

**Strategy:** Surgical, risk-first differential review using baseline comparison, history/blame, complete caller inventory, line-by-line policy analysis, attacker modeling, focused/full tests, typecheck, lint, production build, and browser verification.

**Coverage:** 100% of changed production files and direct policy callers. External backend and settlement implementations were not re-audited because this hotfix does not modify them.
**Confidence:** High for the hotfix diff; medium for the broader repository because it is outside this review scope.
