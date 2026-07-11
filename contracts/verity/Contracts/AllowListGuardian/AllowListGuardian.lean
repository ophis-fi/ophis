import Contracts.Common

/-!
# AllowListGuardian (Ophis) — Verity port

Faithful EDSL port of the Ophis-custom `AllowListGuardian.sol`: the governance wrapper that
splits control of the GPv2 solver allowlist into a SLOW timelock path (`addSolver`, `setManager`,
`setGuardian`) and a FAST guardian path (`removeSolver`).

## Modeling note
The Solidity contract FORWARDS to an external `authenticator` (e.g. `authenticator.addSolver(s)`).
The external call is the LAST statement, executed only if the preceding `require` passed — so the
security property "the forward is gated by role" is exactly "the function reverts unless the caller
holds the role." We therefore model each forwarding function by its access-control guard (the
`require`), which is what the proofs establish. The external authenticator is the canonical CoW
`GPv2AllowListAuthentication` (audited, out of scope). The guardian's OWN protected state is:
  - slot 0 `authenticator` — immutable (never written after construction)
  - slot 1 `timelock`      — immutable (never written after construction)
  - slot 2 `guardian`      — mutable ONLY via `setGuardian`, ONLY by the timelock, ONLY to nonzero
-/

namespace Contracts

open Verity hiding pure bind

verity_contract AllowListGuardian where
  storage
    authenticator : Address := slot 0
    timelock : Address := slot 1
    guardian : Address := slot 2

  constructor (authenticator_ : Address, timelock_ : Address, guardian_ : Address) := do
    require (authenticator_ != 0) "Guardian: zero authenticator"
    require (timelock_ != 0) "Guardian: zero timelock"
    require (guardian_ != 0) "Guardian: zero guardian"
    setStorageAddr authenticator authenticator_
    setStorageAddr timelock timelock_
    setStorageAddr guardian guardian_

  -- ─── SLOW path (timelock, >= 24h) ──────────────────────────────────────
  -- addSolver forwards to authenticator.addSolver(solver); gated by the timelock require.
  function addSolver (solver : Address) : Unit := do
    let sender ← msgSender
    let tl ← getStorageAddr timelock
    require (sender == tl) "Guardian: caller not timelock"

  -- setManager forwards to authenticator.setManager(newManager); timelock-only, rejects zero.
  function setManager (newManager : Address) : Unit := do
    let sender ← msgSender
    let tl ← getStorageAddr timelock
    require (sender == tl) "Guardian: caller not timelock"
    require (newManager != 0) "Guardian: zero manager"

  -- setGuardian rotates the fast-path guardian; timelock-only, rejects zero. This is the ONLY
  -- function that writes the guardian slot.
  function setGuardian (newGuardian : Address) : Unit := do
    let sender ← msgSender
    let tl ← getStorageAddr timelock
    require (sender == tl) "Guardian: caller not timelock"
    require (newGuardian != 0) "Guardian: zero guardian"
    setStorageAddr guardian newGuardian

  -- ─── FAST path (guardian, instant) ─────────────────────────────────────
  -- removeSolver forwards to authenticator.removeSolver(solver); gated by the guardian require.
  -- Defensive (capability-reducing) only, so it is NOT timelocked.
  function removeSolver (solver : Address) : Unit := do
    let sender ← msgSender
    let g ← getStorageAddr guardian
    require (sender == g) "Guardian: caller not guardian"

namespace AllowListGuardian

/-- The slow-path authorization check: caller must be the timelock. -/
def onlyTimelock : Contract Unit := do
  let sender ← msgSender
  let tl ← getStorageAddr timelock
  require (sender == tl) "Guardian: caller not timelock"

/-- The fast-path authorization check: caller must be the guardian. -/
def onlyGuardian : Contract Unit := do
  let sender ← msgSender
  let g ← getStorageAddr guardian
  require (sender == g) "Guardian: caller not guardian"

end AllowListGuardian

end Contracts
