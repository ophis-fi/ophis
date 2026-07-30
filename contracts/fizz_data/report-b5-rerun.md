# Fizz Re-Run — B5 preflight branch (`feat/vault-policy-b5-preflight` @ b8b73fc70)

**Date:** 2026-07-17 · **Prior campaign report:** [`report.md`](report.md) (2026-07-15)

This is a **verification re-run of the existing tuned suite** against the current branch (which added the B5 change: `MAX_STALENESS_CAP` 1d→2d, `b8b73fc70`). The suite was NOT regenerated — the prior hand-tuned handlers/properties were preserved and re-executed against the current source, so this measures whether the B5 change caused any regression.

Both fuzzers build under a temporary `[lint] lint_on_build = false` (forge 1.5's linter + `deny_warnings` otherwise blocks every `forge build`, including the ones crytic/medusa run internally); `foundry.toml` was restored to its original after the run.

## Target 1 — AllowListGuardian governance suite (`FuzzTester`, Medusa)

- **Result: 53 assertion tests passed, 5 failed** — **identical to the prior campaign** (`report.md`: "53 passed, 5 failed … 0 SHOULD-HOLD violations").
- **0 SHOULD-HOLD violations.** All SHOULD-HOLD invariants held (guardian-only removal, timelock-only add/setManager/rotate, no unauthorized manager write, two-step transfer atomicity, `guardian != 0`, admin authority persistence, etc.).
- The 5 failing handler entries are the **designed EXPECTED-VIOLATED leads** (`SP-21`, `SP-23`, `SP-24`, and the `SP-26` family) — they fire by construction to flag the *documented* governance residuals:
  - `gPv2AllowListAuthentication_addSolver_asGuardian` → SP-21: once `manager()` is moved to `GUARDIAN_ROLE` (via individually-authorized propose+accept), the guardian gains instant, undelayed `addSolver` — inverting the SLOW-add / FAST-evict design.
  - `gPv2AllowListAuthentication_setManager_zero` → SP-24: a direct `setManager(0)` temporarily bricks both the direct and Guardian-forwarded paths (recoverable only by the EIP-1967 admin, SP-25).
  - `allowListGuardian_removeSolver` / `_clamped` → SP-23: the fast-evict fail-safe is silently disabled once the timelock moves `manager` off the Guardian.
  - `gPv2AllowListAuthentication_addSolver_clamped` → SP-26: after an authorized X-1 handoff, the new manager gains raw instant add/remove.
  - Every call in every violating sequence is individually authorized — these are unenforced-deployment-convention leads (the `manager() == AllowListGuardian` binding is off-chain governance's responsibility), NOT contract bugs.

## Target 2 — Vault policy module drain invariants (`VaultPolicyEchidna`, Medusa)

- **Result: 2 property tests passed, 0 failed.**
- `echidna_turnover_within_cap()` ✅ — `turnoverSpentUsd() <= dailyUsdTurnoverCap` held across the campaign (the harness fuzzes `rebalance`/`cancel` as the authorized curator; the leaky bucket never exceeded the cap).
- `echidna_no_bad_presignature()` ✅ — for every order left presigned, `receiver == safe`, `feeAmount == 0`, `appData == appDataHash`, and both tokens allowlisted + distinct held — even though the `rebalance` handler actively crafts policy-violating orders (bad receiver / nonzero fee / wrong appData / BUY / partiallyFillable) to try to sneak one past the module.

## Verdict

**No regression from B5.** The guardian suite reproduces the prior campaign's exact pass/expected-fail signature, and the vault drain invariants (the core "compromised curator cannot drain" guarantees) hold under fresh fuzzing on the current source. This corroborates the 12-agent audit conclusion (no exploitable drain) and the x-ray HARDENED verdict.

## Recommended follow-up (from the x-ray test-gap note)

The fuzz harness (`test/fizz/`, `PROPERTIES.md`, `fizz_data/`) is **untracked in git at HEAD** — the fuzzing evidence is not reproducible from the committed tree until it lands. Commit the suite so the campaign is part of the audited history. Optionally, extend the vault harness (`VaultPolicyEchidna`) with a property for the audit's top hardening finding — that a superseded same-token order's presignature is revoked on the next `rebalance` (would fail today, guarding the fix).
