# Ophis OTC Milestones A+B — Differential Review

**Date:** 2026-08-19
**Baseline:** `28002989` (origin/main)
**Review target:** `feat/otc-read-only`
**Deployment:** Not authorized by this review. The feature ships flag-off (`isOtcEnabled` absent from `useFeatureFlags` defaults); Milestones C+ (any transaction path) require separate implementation, security review, and explicit owner approval per `docs/development/plans/2026-08-18-ophis-otc.md`.

## Executive Summary

This diff adds a strictly read-only OTC surface: a pinned Ethereum manifest + fail-closed contract adapter + subgraph index client + direct on-chain reconciliation (`src/ophis/otc/`, OTC Milestone A) and a flag-gated `/otc` browse/detail UI (`src/pages/Otc/`, OTC Milestone B), with a zero-dependency mainnet canary and scoped CI test gates.

A five-lens adversarial review (correctness, security, spec-compliance, accessibility/UX-honesty, house conventions) was run over the full diff, with every finding independently verified by two adversarial agents instructed to refute it.

| Stage | Count |
|---|---|
| Raw findings | 51 |
| Confirmed (2-of-2 verification) | 20 — **all fixed in-branch** |
| Contested (1-of-2) | 29 — 12 fixed, 17 triaged as documented deferrals or refuted on re-read |
| Refuted outright | 2 |

In addition, an independent external review (OpenAI Codex, gpt-5.6-sol at xhigh reasoning) was run pre-merge in five iterative rounds on 2026-08-20:

| Codex round | Findings | Outcome |
|---|---|---|
| 1 | 5 (1×P1: missing eth_chainId guard) | all confirmed, all fixed |
| 2 | 5 (1×P1: wagmi signer-API denylist gap → allowlist) | all confirmed, all fixed |
| 3 | 4 (mount-fresh list key, node-stale detection, coverage holes, canary entity freeze) | all confirmed, all fixed |
| 4 | 3 (node-stale ordering + detail propagation, canary symmetry) | all confirmed, all fixed |
| 5 | 0 — **verdict: "patch is correct"** | clean |

Cumulative: 17/17 external findings confirmed and fixed. Notable additions from these rounds: chain-id verification in both readers, a wagmi named-import ALLOWLIST (usePublicClient only) on top of recursive signer-API content scans, chain-authoritative status with index lifecycle claims explicitly labeled untrusted, a degradation taxonomy of node-stale > index-corrupt > index-stale surfaced on both views, mount-fresh SWR keys on both views, and canary checks for both lag directions plus frozen entity data.

Open findings after fixes: **none at critical/high severity.** Remaining items are recorded deferrals (below), each either spec-optional, scheduled for a later milestone by the plan itself, or a deliberate convention match.

## What Changed (risk-ranked)

| Area | Files | Risk | Notes |
|---|---|---|---|
| Read-only contract adapter | `src/ophis/otc/{otc.const,otc.abi,otc.types,parseOtcOrders,readOtcSnapshot}.ts` | Medium | Settlement-authority reads. Fail-closed: pinned runtime code hash (verified 2026-08-19 vs publicnode+drpc+Sourcify exact_match), `weth()` wiring check, single-block pinning, post-read block-hash confirmation — enforced identically by the snapshot reader AND the single-order reader. Strict decode; 0-based ids (id 0 is a real order, verified on-chain). |
| Index client + reconciliation | `src/ophis/otc/{otcSubgraph,reconcileOtcOrders,useOtcData}.ts` | Medium | Subgraph is enrichment only. Exact-equality reconciliation on immutable fields; active-flag disagreement classified as index lag, never corruption and never verified. Index failure/staleness only degrades — with honest, distinct UI reasons. |
| UI pages | `src/pages/Otc/*`, `routes.ts`, `RoutesApp.tsx` | Medium | Flag-off in production; pages self-guard and redirect home. No transaction selector reachable (see invariants). Curated-metadata-only rendering; unreviewed tokens shown as raw units + address. |
| Token policy | `libs/tokens/src/services/tokenPolicy.ts` | Low | Third enum member `OTC_ESCROW` (WETH/USDC/DAI, mainnet-only, no native sentinel). All 13 existing call sites pass their existing profile explicitly and are behaviorally unchanged (25 policy tests green, incl. every pre-existing case). |
| CI / canary | `scripts/otc-mainnet-canary.mjs`, `.github/workflows/{otc-mainnet-canary,frontend-ci}.yml` | Low | Read-only guards that provably bind: canary self-test includes a crafted-mutation drift check; jest gates use `--passWithNoTests=false` so a zero-match filter fails instead of passing silently. |

## Invariants and how they are enforced

1. **No transaction selector reachable.** The read ABI contains only `view` fragments; computed selectors are pinned to the deployed dispatcher's read selectors; the 7 write selectors are pinned as data and asserted non-encodable; `enabledTransactionSelectors` is pinned `[]`; a two-tier boundary test forbids trading/allowance/permit/signing/solver/`wallet-provider` imports across BOTH the adapter module (which also forbids `@cowprotocol/wallet` entirely) and the `pages/Otc` production surface. `receive()`/empty-calldata paths are documented as equally out of scope (no code constructs a plain value transfer).
2. **Fail closed.** Code-hash mismatch, `weth()` wiring mismatch, malformed decode, oversized returndata, or block-hash drift under the read all throw; the UI then renders zero rows with an explicit "hidden rather than shown unverified" notice. Verified by unit tests on both readers and by the mutation-checked live canary.
3. **Index is never settlement authority.** Rows render from the on-chain snapshot; the subgraph only decorates (ages/history) and is reconciled field-exactly; the detail route performs a fresh direct `getOrder` read and demands a refresh when the indexed copy disagrees.
4. **Exact math.** All on-chain values flow through bigint-only formatting; rates truncate (never round up) and refuse to render truncated-to-zero prices.
5. **Scoped policy.** `OTC_ESCROW` cannot leak: the profile parameter is compile-time-required (PR #1201 boundary) and no existing call site changed. The curated display set is bound to the policy by a drift test.

## Fixed during review (selection)

- `readOtcOrder` previously omitted the `weth()` check and block re-read (detail page could render what the list page refused) — now identical guards.
- Boundary scan previously covered only the adapter directory and carried a vacuous named-export fragment — now covers `pages/Otc` with specifier-level fragments.
- Degraded banner claimed data was hidden while stale data rendered — now `index-unavailable` (hidden) and `index-stale` (shown, labeled lagging) are distinct.
- Detail route was unreachable — order ids now link to `/otc/:orderId`; rows gained copy + explorer actions with screen-reader-accessible full addresses.
- Invalid `role="tablist"` ARIA; color-only active tab; unwrapped 42-char addresses on phones; canary false-alarm on index-ahead-of-node skew; first-match manifest extractor — all fixed.

## Recorded deferrals (no code change; intentional)

- **Mobile card layout**: the table scrolls inside its own wrapper (body never scrolls horizontally, verified at 390px); dedicated cards are GA-polish (plan milestone G).
- **USD context / reference-price deviation**: spec marks deviation "optional"; needs a price-feed dependency — deferred; exact rate + pair direction shown instead.
- **Maker verified names**: no name registry integration in v1.
- **Public navigation entry**: plan reserves public navigation for Milestone G; the route is deep-link only and flag-gated.
- **`OTC_ESCROW` at write sinks**: write sinks do not exist in A/B; the profile ships now so Milestone C wires `assertTradeTokenPolicy(..., OTC_ESCROW)` at every sink; display-review binding exists today via the curated set + drift test.
- **SWR over `atomWithQuery`**: matches the dominant live data-fetching pattern in the app (and the discovery precedent); revisit if the COW-573 migration lands.
- **Checkpointed `eth_getLogs` ingestion**: not needed for A/B (enumeration bootstrap covers state; no `eth_getLogs` call exists in the diff); the Ophis-owned event mirror is pre-GA production work per the plan.

## Validation

- 110 jest tests green (85 OTC module+pages, 25 token policy), executed by the new scoped, `--passWithNoTests=false` CI steps.
- `nx run cowswap-frontend:typecheck` green; full production `build:cowswap` green (twice: pre- and post-review fixes).
- Canary `--self-test` green (keccak vectors, fixture decode, manifest agreement, crafted-drift detection) and live run green against mainnet (code hash pinned, `weth()` wired, `nextOrderId=144`, newest orders reconciled exactly).
- Visual verification against live mainnet data on desktop and 390px mobile: browse, detail, my-orders (disconnected), disabled create, no body horizontal scroll.

This review does not authorize deployment and is not a human audit or an endorsement by any external organization.
