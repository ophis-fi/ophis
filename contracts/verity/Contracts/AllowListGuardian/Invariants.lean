/-
  State invariants for the AllowListGuardian contract.

  Defines properties that should always hold, regardless of operations.

  Mirrors `Contracts/Owned/Invariants.lean`. The security-critical invariant is
  `guardian_nonzero` (storage slot 2 ≠ 0): the fast-path defensive `removeSolver`
  authority must never be the zero address (the constructor and `setGuardian` both
  reject zero). The other nonzero fields mirror Owned and ease frame proofs.
-/

import Verity.Specs.Common

namespace Contracts.AllowListGuardian.Invariants

open Verity

/-! ## State Invariants

Properties that should be maintained by all operations.
-/

/-- Well-formed contract state:
    - Sender address is nonzero
    - Contract address is nonzero
    - authenticator address (slot 0) is nonzero  (immutable after construction)
    - timelock address (slot 1) is nonzero       (immutable after construction)
    - guardian address (slot 2) is nonzero       (the core security invariant)
-/
structure WellFormedState (s : ContractState) : Prop where
  sender_nonzero : s.sender ≠ 0
  contract_nonzero : s.thisAddress ≠ 0
  authenticator_nonzero : s.storageAddr 0 ≠ 0
  timelock_nonzero : s.storageAddr 1 ≠ 0
  guardian_nonzero : s.storageAddr 2 ≠ 0

end Contracts.AllowListGuardian.Invariants
