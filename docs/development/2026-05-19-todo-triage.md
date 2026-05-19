# Backend in-code TODO triage

**Date:** 2026-05-19
**Scope:** Production code (non-test) TODOs in `crates/driver` + `crates/autopilot`.
**Trigger:** Roadmap task 5.1.

## Buckets

### 🟢 Bucket A — Actionable now (small PR each)

| File:line | Comment | Action |
|---|---|---|
| `driver/.../liquidity/mod.rs:1` | `// TODO Remove dead_code` | Remove the `#[allow(dead_code)]` and clean up actually-dead items. T. |
| `driver/.../order/mod.rs:255` | `// TODO These doc comments are incorrect for limit orders` | Update doc comments for the limit-order fields. T. |
| `driver/.../solver/mod.rs:46` | `// TODO check name uniqueness on solver registration` | Add a HashSet check at registration. T. |
| `autopilot/.../auction/mod.rs:60` | `// TODO: Remove this method and use the `in_eth` function instead` | Direct replacement; verify no callers depend on old method shape. T. |

### 🟡 Bucket B — Was-blocked, now-actionable (contracts deployed)

These were "TODO when contracts are deployed". Contracts ARE deployed on OP (and HL, paused). Should flip from `Option<Address>` / fallback addresses to required addresses.

| File:line | Comment | Action |
|---|---|---|
| `driver/.../blockchain/contracts.rs:22` | `// TODO: make this non-optional when contracts are deployed` (FlashloanRouter) | Make `Option<Address>` → `Address`; per-chain config required. S. Verify HL+OP+Eth-mainnet (eventual) all have it. |
| `driver/.../blockchain/contracts.rs:94` | `// TODO: use `address_for()` once contracts are deployed` | Replace inline address lookup with `address_for()` helper. T. |
| `driver/.../solution/encoding.rs:32` | `// TODO: remove when contracts are deployed everywhere` (likely a temp `Option` somewhere) | Inspect + remove gating. S. |

### 🔵 Bucket C — Real architectural debt (M-sized)

| File:line | Comment | Why it matters |
|---|---|---|
| `driver/.../order/mod.rs:177` | `// TODO: prohibit construction of orders with bad invariants` | Type-system enforcement of order validity. Currently invariants are checked at consume sites. Centralizing prevents the "forgot to validate" footgun the Phase 2 audit flagged elsewhere. Likely M. |
| `driver/.../order/signature.rs:14` | `// TODO Different signing schemes imply different sizes of signature data` | Refactor signature handling per scheme. Touches the M4 sites we just fixed (EIP-1271 + PreSign panic guards in PR #100). Could obsolete those guards if done correctly. M. |
| `driver/.../solution/mod.rs:45` | `// TODO Add a constructor and ensure clearing prices are included` | Type-level invariant: every solution has matching clearing prices. Bug-class elimination. S-M. |
| `autopilot/.../solvable_orders.rs:632` | `// TODO: replace with proper detection logic` (some placeholder detection) | Read context for severity — could be a correctness issue. S to investigate, M to fix properly. |

### 🟠 Bucket D — Upstream-pending (leave)

| File:line | Comment | Why leave |
|---|---|---|
| `autopilot/.../settlement/mod.rs:170` | `TODO: remove once cowprotocol/services#2848 is resolved + ~270 days` | Date-gated cleanup. The 270-day window after the upstream fix is the safety period. Not actionable until upstream merges. |
| `driver/.../quote.rs:157` | `TODO(#1468): choose best solution in the future, but for now just pick` | Tracked as upstream issue. Wait. |
| `driver/.../solver/mod.rs:233` | `TODO: Remove once all solvers are moved to use limit orders for quoting` | Upstream/multi-solver coordination. Wait. |
| `autopilot/.../database/events.rs:34` | `// TODO: handle new events` | Open-ended; depends on which events get added next. Leave until a new event type is added. |

### 🔴 Bucket E — Surplus-token cluster (already-tracked separately)

These 3 sites cluster around the "surplus token" handling. Were called out in the Phase 2 session handoff as their own ticket.

| File:line | Comment |
|---|---|
| `autopilot/.../settlement/mod.rs:129` | `// TODO surplus token` |
| `autopilot/.../settlement/trade/mod.rs:180` | `// TODO surplus token` |
| `driver/.../solution/mod.rs:543` | `// TODO: We should probably filter out all unused prices to save gas` |

Action: leave for a dedicated surplus-token PR (referenced in `docs/audits/2026-05-18-phase2-backend.md` ticket cluster).

### ⚪ Bucket F — Already-questions, not-TODOs

These are speculative / informational, not actual gaps.

| File:line | Comment |
|---|---|
| `driver/.../solution/dto/solution.rs:52` | `// TODO this error should reference the UID` (cosmetic err-msg improvement) |
| `driver/.../liquidity/mod.rs:46` | `// TODO: Should we allow `reqwest::Client` configuration here?` (open question, not a bug) |
| `driver/.../blockchain/gas.rs:50` | `// TODO: simplify logic by moving gas price adjustments out of the individual` (refactor wish) |
| `driver/.../solution/encoding.rs:180` | `// TODO configure min slippage` (config plumbing wish) |

Action: leave; revisit if related work brings them into scope.

## Headline summary

- **23 production TODOs.**
- **4 actionable-now (Bucket A)** — small cosmetic PRs.
- **3 actionable-post-deploy (Bucket B)** — should flip now that OP contracts are live.
- **4 architectural (Bucket C)** — bigger, justify-in-PR.
- **4 upstream-pending (Bucket D)** — don't touch.
- **3 surplus-token cluster (Bucket E)** — separate ticket.
- **5 speculative (Bucket F)** — leave.

## Recommended next pass

If you want a low-risk PR sequence after the HL pivot:

1. **One PR per Bucket A item** (4 small PRs, each <100 LOC) — easy review, fast turnaround.
2. **One bundled PR for Bucket B** — they all "flip Option to required" together; coordinated change touches the per-chain deploy config.
3. **Don't tackle Bucket C yet** — wait until either (a) it blocks a real feature, or (b) a Phase 4 audit specifically calls it out.

If you'd rather not generate PRs from this triage, leave the doc as the authoritative state-of-TODOs and revisit in the next session.
