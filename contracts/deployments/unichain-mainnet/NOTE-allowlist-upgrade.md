# GPv2AllowListAuthentication governance — Unichain (chain 130)

The AllowList `manager()` and proxy `owner()` were migrated off the bare 2-of-3
Safe to a 24h `TimelockController` + `AllowListGuardian` on 2026-06-29 (the #442
Option-A model, mirroring Optimism). Recorded here so a future audit/stats run
can't mis-flag the `manager` row as the bare Safe.

On-chain state (Unichain mainnet, verified 2026-06-29 post-migration):

| | Address |
|---|---|
| Proxy | `0x1002E12f2e7f848b20fe572F92133E467a5D010C` |
| Implementation | `0x2Ddcc99cD0F2Ba3De0cc37B28ec89921814bBe35` (two-step-manager impl) |
| Manager | `0x4821A534FB11ea4bb2f88d48B13A498A80462e64` (AllowListGuardian) |
| Owner / proxy admin | `0xFC2A6a54122E6D0a598CAe7453DD61263c1065Ed` (TimelockController, 24h) |
| Protocol Safe (proposer/executor/guardian) | `0xe049a64546fb8564CC4c7D64A0A1BAe00Aa801cF` (2-of-3) |

## Governance model

The `Manager` is the **AllowListGuardian** `0x4821A534…462e64`, **not** a single
key, and the proxy `Owner` is the **TimelockController** `0xFC2A6a54…1065Ed`.
Verified on-chain post-migration: proxy `manager()` == Guardian, `owner()` ==
Timelock, `pendingManager()` == 0; Guardian `guardian()` == Safe, `timelock()` ==
Timelock, `authenticator()` == proxy.

- **Slow path** (`addSolver`, `setManager`, `setGuardian`, `upgradeTo`): only the
  proxy `owner()`, the 24h `TimelockController` `0xFC2A6a54…1065Ed`, can call. Its
  sole proposer and executor is the 2-of-3 protocol Safe
  `0xe049a64546fb8564CC4c7D64A0A1BAe00Aa801cF` (threshold 2). Every solver
  addition or upgrade therefore waits a mandatory 24 hours.
- **Fast path** (`removeSolver`): the Guardian, whose `guardian()` is that same
  2-of-3 Safe, can evict a compromised solver instantly (no delay).

`0xe049…01cF` is the 2-of-3 protocol Safe, **not** an externally-owned key.
Pointing `Manager` back at the bare Safe would be a regression — it removes the
24h delay on solver additions and upgrades. The authoritative, on-chain-matching
governance doc is `infra/unichain-mainnet/deploy/timelock-governance-runbook.md`
(the Unichain mirror of `docs/operations/allowlist-governance-runbook.md`).

## Deploy provenance

TimelockController + AllowListGuardian were deployed by a gas-only EOA
`0x40a8D159Bdf9DD76d074cA6C6d949E0575ef9e7f`, whose `TIMELOCK_ADMIN_ROLE` was then
renounced (it now holds zero authority). The migration batch
(`setManager(Guardian)` + `transferOwnership(Timelock)` on the proxy) was signed
2-of-3 by the protocol Safe. The deploy was fork-simulated against live chain-130
state before signing (manager→Guardian, owner→Timelock; add/upgrade revert without
the 24h timelock; instant removeSolver preserved; Timelock-owner rescue = no
permanent brick).
