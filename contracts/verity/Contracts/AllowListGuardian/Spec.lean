/-
  Formal specifications for AllowListGuardian operations.

  Mirrors `Contracts/Owned/Spec.lean`.

  Modeling note: addSolver/setManager/removeSolver have NO storage effect of their
  own (in Solidity they forward to the external `authenticator`; the forward is the
  last statement, gated by the preceding role `require`). We therefore model them
  by their authorization guard and a "no storage slot changes" frame. setGuardian
  is the only function that writes a guardian-slot, so it gets a real
  `storageAddrUpdateSpec` on slot 2.
-/

import Verity.Specs.Common
import Verity.Macro
import Contracts.AllowListGuardian.AllowListGuardian

namespace Contracts.AllowListGuardian.Spec

open Verity
open Verity.Specs
open Contracts.AllowListGuardian

/-! ## Operation Specifications -/

-- setGuardian: updates the guardian (slot 2) to the new address (timelock only,
-- nonzero only). Address slots 0 and 1, all other storage, and context unchanged.
#gen_spec_addr setGuardian_spec for (newGuardian : Address) (2, (fun _ => newGuardian), sameStorageMapContext)

/-- addSolver: forwards to the authenticator (timelock only). No storage slot of the
    guardian itself changes. -/
def addSolver_spec (_solver : Address) (s s' : ContractState) : Prop :=
  s'.storageAddr = s.storageAddr ∧
  Specs.sameStorageMapContext s s'

/-- setManager: forwards to the authenticator (timelock only, nonzero only). No
    storage slot of the guardian itself changes. -/
def setManager_spec (_newManager : Address) (s s' : ContractState) : Prop :=
  s'.storageAddr = s.storageAddr ∧
  Specs.sameStorageMapContext s s'

/-- removeSolver: forwards to the authenticator (guardian only). No storage slot of
    the guardian itself changes. -/
def removeSolver_spec (_solver : Address) (s s' : ContractState) : Prop :=
  s'.storageAddr = s.storageAddr ∧
  Specs.sameStorageMapContext s s'

end Contracts.AllowListGuardian.Spec
