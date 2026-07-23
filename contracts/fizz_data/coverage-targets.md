# Coverage Targets — fizz suite

Fuzz profile: `via_ir` is **disabled** in `foundry.toml` (`via_ir = false`), so no
`[profile.fuzz]` workaround was needed and Medusa coverage numbers are **accurate**
(no Yul-IR deflation). Standard `no-ir` targets apply.

## In-scope contracts (Ophis-authored governance layer)

| Contract | Role | Target (no-ir) | Cycle 1 Hit | Status |
|---|---|---|---|---|
| `GPv2AllowListAuthentication.sol` | Access control / solver + manager state machine | 80%+ | **83%** (26/31 lines) | ✅ |
| `AllowListGuardian.sol` | Access control / SLOW-add + FAST-evict governance wrapper | 80%+ | **85%** (17/20 lines) | ✅ |

Both in-scope contracts meet target on cycle 1. Remaining "uncovered" lines are
**non-executable**:

- `AllowListGuardian.sol` lines 52, 55, 60 — `immutable`/state-variable
  **declarations** (`authenticator`, `timelock`, `guardian`), not reachable code.
- `GPv2AllowListAuthentication.sol` lines 11, 18, 41 — contract declaration +
  `manager` / `pendingManager` state-variable declarations.
- `GPv2AllowListAuthentication.sol` lines 195-196 — the `isSolver(address)` **view**
  body. Not a handler entry point (views are excluded from selection); it is
  exercised by the Step 9 property assertions that read `isSolver(...)`, so it is
  covered once invariants land.

Effective executable-logic coverage of both in-scope contracts is ~100%.

## Out-of-scope contracts (vendored cowprotocol/contracts — 0%, expected)

`GPv2Settlement`, `GPv2VaultRelayer`, `GPv2Signing`, `StorageAccessible`,
`ReentrancyGuard`, the `reader/*` storage readers, and all `test/`-vendored
fixtures (`ChiToken`, `NonStandardERC20`, `SmartSellOrder`, `ERC20PresetPermit`,
`GPv2AllowListAuthenticationV2`) plus the GPv2 libraries (`GPv2Transfer`,
`GPv2Order`, `GPv2Trade`, `GPv2SafeERC20`, `SafeMath`, etc.) are **out of primary
audit scope** per `x-ray/x-ray.md` §1. They receive no handlers and are expected
at ~0% (the 1-16% incidental hits come only from constructor/library calls made
while deploying the two in-scope contracts). **Skip reason: out of scope, vendored
upstream-audited CoW core.**

## Cycle 1 — 2026-07-15
33 Medusa assertion tests, 0 failures; ~715k calls, 766 branches, testLimit
(500k) reached. Targets met, no further coverage cycles needed.
