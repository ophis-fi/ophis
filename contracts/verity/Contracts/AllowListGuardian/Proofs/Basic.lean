/-
  Security proofs for the AllowListGuardian contract (Ophis #442).

  Proves the 7 security properties that the Echidna harness
  (`echidna/E2EAllowListGuardian.sol`) fuzzes, here established over ALL states.

  Mirrors `Contracts/Owned/Proofs/Basic.lean` (same EDSL, same
  "unfold-under-authorization-hypothesis" pattern). All access-control guards
  (`onlyTimelock`, `onlyGuardian`) and the `!= 0` requires are FULLY modeled with
  `ContractResult`, so the success-path unfold lemmas can be discharged directly.

  Modeling note (FAITHFULNESS): the Solidity functions addSolver/setManager/
  removeSolver forward to an external `authenticator` as their last statement,
  executed only if the preceding role `require` passed. We model each by its
  guard, so the proven property "this function only takes effect when the caller
  holds the role" is exactly "the forward is gated by role". The guardian's OWN
  protected storage is what we reason about:
    - slot 0 authenticator — immutable (never written post-construction)
    - slot 1 timelock      — immutable (never written post-construction)
    - slot 2 guardian      — written ONLY by setGuardian, ONLY by the timelock,
                             ONLY to a nonzero address.
-/

import Contracts.AllowListGuardian.Spec
import Contracts.AllowListGuardian.Invariants
import Verity.Proofs.Stdlib.Automation

namespace Contracts.AllowListGuardian.Proofs

open Verity
open Contracts.AllowListGuardian
open Contracts.AllowListGuardian.Spec
open Verity.Proofs.Stdlib.Automation (wf_of_state_eq address_beq_false_of_ne)
open Contracts.AllowListGuardian.Invariants

/-! ## §0 Storage-slot basics (mirror Owned) -/

theorem setStorageAddr_updates_guardian (s : ContractState) (addr : Address) :
  let s' := ((setStorageAddr guardian addr).run s).snd
  s'.storageAddr 2 = addr := by
  simp [guardian]

theorem setStorageAddr_guardian_preserves_other_slots (s : ContractState) (addr : Address)
  (slot_num : Nat) (h : slot_num ≠ 2) :
  let s' := ((setStorageAddr guardian addr).run s).snd
  s'.storageAddr slot_num = s.storageAddr slot_num := by
  simp [guardian, h]

/-! ## §1 Constructor

  Faithful success-path model: when the three `require (· != 0)` guards pass, the
  constructor body runs the three `setStorageAddr` writes in order
  (authenticator → timelock → guardian). We state the constructor theorems over
  that write sequence, exactly as Owned states them over its single write.
-/

/-- The success-path constructor body: the three address writes in source order. -/
def constructorBody (authenticator_ timelock_ guardian_ : Address) : Contract Unit := do
  setStorageAddr authenticator authenticator_
  setStorageAddr timelock timelock_
  setStorageAddr guardian guardian_

/-- THEOREM 1. The constructor sets slot 0 = authenticator_, slot 1 = timelock_,
    slot 2 = guardian_ (mirror `constructor_sets_owner`). -/
theorem constructor_sets_slots (s : ContractState) (authenticator_ timelock_ guardian_ : Address) :
  let s' := ((constructorBody authenticator_ timelock_ guardian_).run s).snd
  s'.storageAddr 0 = authenticator_ ∧
  s'.storageAddr 1 = timelock_ ∧
  s'.storageAddr 2 = guardian_ := by
  refine ⟨?_, ?_, ?_⟩ <;>
    simp [constructorBody, authenticator, timelock, guardian,
      setStorageAddr, Verity.bind, Bind.bind, Contract.run, ContractResult.snd]

/-- The constructor leaves the contract context (sender, this) unchanged. -/
theorem constructor_preserves_context (s : ContractState) (authenticator_ timelock_ guardian_ : Address) :
  let s' := ((constructorBody authenticator_ timelock_ guardian_).run s).snd
  s'.sender = s.sender ∧ s'.thisAddress = s.thisAddress := by
  refine ⟨?_, ?_⟩ <;>
    simp [constructorBody, authenticator, timelock, guardian,
      setStorageAddr, Verity.bind, Bind.bind, Contract.run, ContractResult.snd]

/-- THEOREM 2. The constructor preserves well-formedness: given a well-formed prior
    state and three nonzero arguments, the post-construction state is well-formed —
    in particular the guardian slot 2 is nonzero (mirror
    `constructor_preserves_wellformedness`). -/
theorem constructor_preserves_wellformedness (s : ContractState)
  (authenticator_ timelock_ guardian_ : Address)
  (h : WellFormedState s)
  (h_auth : authenticator_ ≠ 0) (h_tl : timelock_ ≠ 0) (h_g : guardian_ ≠ 0) :
  let s' := ((constructorBody authenticator_ timelock_ guardian_).run s).snd
  WellFormedState s' := by
  obtain ⟨h_slot0, h_slot1, h_slot2⟩ := constructor_sets_slots s authenticator_ timelock_ guardian_
  obtain ⟨h_sender, h_this⟩ := constructor_preserves_context s authenticator_ timelock_ guardian_
  exact ⟨h_sender ▸ h.sender_nonzero, h_this ▸ h.contract_nonzero,
    h_slot0 ▸ h_auth, h_slot1 ▸ h_tl, h_slot2 ▸ h_g⟩

/-! ## §2 addSolver — SLOW path, timelock-only, no storage effect

  THEOREM 3. addSolver takes effect (succeeds) only when `s.sender = s.storageAddr 1`
  (the timelock), and preserves ALL storage slots (0, 1, 2 unchanged). The Solidity
  forward to `authenticator.addSolver` is the last statement after the guard, so
  "succeeds iff timelock" is exactly the access-control property.
-/

/-- Success-path unfold: when the caller is the timelock, `addSolver` succeeds and
    leaves the state completely unchanged (the body is only the guard). -/
theorem addSolver_unfold (s : ContractState) (solver : Address)
  (h_tl : s.sender = s.storageAddr 1) :
  (addSolver solver).run s = ContractResult.success () s := by
  verity_unfold addSolver with h_tl
  simp [timelock]

/-- addSolver, when authorized, satisfies its spec: no storage slot changes. -/
theorem addSolver_meets_spec_when_timelock (s : ContractState) (solver : Address)
  (h_tl : s.sender = s.storageAddr 1) :
  let s' := ((addSolver solver).run s).snd
  addSolver_spec solver s s' := by
  rw [addSolver_unfold s solver h_tl]
  refine ⟨rfl, ?_⟩
  simp [ContractResult.snd, Specs.sameStorageMapContext,
    Specs.sameStorage, Specs.sameStorageMap, Specs.sameStorageArray, Specs.sameContext]

/-- addSolver preserves every address slot when authorized (0, 1, 2 unchanged). -/
theorem addSolver_preserves_all_slots_when_timelock (s : ContractState) (solver : Address)
  (h_tl : s.sender = s.storageAddr 1) (n : Nat) :
  let s' := ((addSolver solver).run s).snd
  s'.storageAddr n = s.storageAddr n := by
  rw [addSolver_unfold s solver h_tl]; rfl

/-! ## §3 setManager — SLOW path, timelock-only AND nonzero, no storage effect

  THEOREM 4. setManager takes effect only when `s.sender = s.storageAddr 1` AND
  `newManager ≠ 0`; preserves all storage slots.
-/

/-- Success-path unfold: when the caller is the timelock and `newManager ≠ 0`,
    `setManager` succeeds and leaves the state unchanged. -/
theorem setManager_unfold (s : ContractState) (newManager : Address)
  (h_tl : s.sender = s.storageAddr 1) (h_nz : newManager ≠ 0) :
  (setManager newManager).run s = ContractResult.success () s := by
  verity_unfold setManager with h_tl
  simp [timelock, h_nz]

/-- setManager, when authorized, satisfies its spec: no storage slot changes. -/
theorem setManager_meets_spec_when_timelock (s : ContractState) (newManager : Address)
  (h_tl : s.sender = s.storageAddr 1) (h_nz : newManager ≠ 0) :
  let s' := ((setManager newManager).run s).snd
  setManager_spec newManager s s' := by
  rw [setManager_unfold s newManager h_tl h_nz]
  refine ⟨rfl, ?_⟩
  simp [ContractResult.snd, Specs.sameStorageMapContext,
    Specs.sameStorage, Specs.sameStorageMap, Specs.sameStorageArray, Specs.sameContext]

/-- setManager preserves every address slot when authorized (0, 1, 2 unchanged). -/
theorem setManager_preserves_all_slots_when_timelock (s : ContractState) (newManager : Address)
  (h_tl : s.sender = s.storageAddr 1) (h_nz : newManager ≠ 0) (n : Nat) :
  let s' := ((setManager newManager).run s).snd
  s'.storageAddr n = s.storageAddr n := by
  rw [setManager_unfold s newManager h_tl h_nz]; rfl

/-! ## §4 setGuardian — SLOW path, timelock-only AND nonzero, rotates slot 2

  THEOREM 5. setGuardian takes effect only when `s.sender = s.storageAddr 1` AND
  `newGuardian ≠ 0`; and when authorized `s'.storageAddr 2 = newGuardian` while
  slots 0 and 1 (authenticator/timelock) are preserved. setGuardian is the ONLY
  writer of slot 2.
-/

/-- Success-path unfold: when the caller is the timelock and `newGuardian ≠ 0`,
    `setGuardian` succeeds, writing slot 2 := newGuardian and touching nothing else. -/
theorem setGuardian_unfold (s : ContractState) (newGuardian : Address)
  (h_tl : s.sender = s.storageAddr 1) (h_nz : newGuardian ≠ 0) :
  (setGuardian newGuardian).run s = ContractResult.success ()
    { s with
      storageAddr := fun slotIdx => if (slotIdx == 2) = true then newGuardian else s.storageAddr slotIdx } := by
  verity_unfold setGuardian with h_tl
  simp [timelock, guardian, h_nz]
  exact h_tl

/-- setGuardian, when authorized, satisfies its spec (slot 2 := newGuardian, others same). -/
theorem setGuardian_meets_spec_when_timelock (s : ContractState) (newGuardian : Address)
  (h_tl : s.sender = s.storageAddr 1) (h_nz : newGuardian ≠ 0) :
  let s' := ((setGuardian newGuardian).run s).snd
  setGuardian_spec newGuardian s s' := by
  rw [setGuardian_unfold s newGuardian h_tl h_nz]
  refine ⟨?_, ?_, ?_⟩
  · simp [ContractResult.snd]
  · intro slotIdx h_neq
    simp [ContractResult.snd, h_neq]
  · simp [ContractResult.snd, Specs.sameStorageMapContext,
      Specs.sameStorage, Specs.sameStorageMap, Specs.sameStorageArray, Specs.sameContext]

/-- setGuardian sets slot 2 to the new guardian when authorized. -/
theorem setGuardian_sets_guardian_when_timelock (s : ContractState) (newGuardian : Address)
  (h_tl : s.sender = s.storageAddr 1) (h_nz : newGuardian ≠ 0) :
  let s' := ((setGuardian newGuardian).run s).snd
  s'.storageAddr 2 = newGuardian := by
  rw [setGuardian_unfold s newGuardian h_tl h_nz]
  simp [ContractResult.snd]

/-- setGuardian preserves slots 0 (authenticator) and 1 (timelock) when authorized. -/
theorem setGuardian_preserves_immutables_when_timelock (s : ContractState) (newGuardian : Address)
  (h_tl : s.sender = s.storageAddr 1) (h_nz : newGuardian ≠ 0) :
  let s' := ((setGuardian newGuardian).run s).snd
  s'.storageAddr 0 = s.storageAddr 0 ∧ s'.storageAddr 1 = s.storageAddr 1 := by
  rw [setGuardian_unfold s newGuardian h_tl h_nz]
  refine ⟨?_, ?_⟩ <;> simp [ContractResult.snd]

/-! ## §5 removeSolver — FAST path, guardian-only, no storage effect

  THEOREM 6. removeSolver takes effect only when `s.sender = s.storageAddr 2`
  (the guardian); preserves all storage slots.
-/

/-- Success-path unfold: when the caller is the guardian, `removeSolver` succeeds and
    leaves the state completely unchanged. -/
theorem removeSolver_unfold (s : ContractState) (solver : Address)
  (h_g : s.sender = s.storageAddr 2) :
  (removeSolver solver).run s = ContractResult.success () s := by
  verity_unfold removeSolver with h_g
  simp [guardian]

/-- removeSolver, when authorized, satisfies its spec: no storage slot changes. -/
theorem removeSolver_meets_spec_when_guardian (s : ContractState) (solver : Address)
  (h_g : s.sender = s.storageAddr 2) :
  let s' := ((removeSolver solver).run s).snd
  removeSolver_spec solver s s' := by
  rw [removeSolver_unfold s solver h_g]
  refine ⟨rfl, ?_⟩
  simp [ContractResult.snd, Specs.sameStorageMapContext,
    Specs.sameStorage, Specs.sameStorageMap, Specs.sameStorageArray, Specs.sameContext]

/-- removeSolver preserves every address slot when authorized (0, 1, 2 unchanged). -/
theorem removeSolver_preserves_all_slots_when_guardian (s : ContractState) (solver : Address)
  (h_g : s.sender = s.storageAddr 2) (n : Nat) :
  let s' := ((removeSolver solver).run s).snd
  s'.storageAddr n = s.storageAddr n := by
  rw [removeSolver_unfold s solver h_g]; rfl

/-! ## §6 Guard-revert: the access-control negative direction (mirror Owned's
    `transferOwnership_reverts_when_not_owner`)

  These strengthen §2–§5: not only does each privileged function take effect when
  the role holds, it REVERTS (and so cannot forward to the authenticator / cannot
  write slot 2) when the caller lacks the role. Together with the Echidna model
  (roles set to addresses outside the fuzzer's sender set), this is exactly why
  "no non-timelock can add a solver / set the manager / rotate the guardian" and
  "no non-guardian can remove a solver".
-/

/-- addSolver reverts when the caller is not the timelock. -/
theorem addSolver_reverts_when_not_timelock (s : ContractState) (solver : Address)
  (h_not : s.sender ≠ s.storageAddr 1) :
  ∃ msg, (addSolver solver).run s = ContractResult.revert msg s := by
  simp [addSolver, timelock, msgSender, getStorageAddr,
    Verity.require, Verity.bind, Bind.bind, Contract.run,
    address_beq_false_of_ne s.sender (s.storageAddr 1) h_not]

/-- removeSolver reverts when the caller is not the guardian. -/
theorem removeSolver_reverts_when_not_guardian (s : ContractState) (solver : Address)
  (h_not : s.sender ≠ s.storageAddr 2) :
  ∃ msg, (removeSolver solver).run s = ContractResult.revert msg s := by
  simp [removeSolver, guardian, msgSender, getStorageAddr,
    Verity.require, Verity.bind, Bind.bind, Contract.run,
    address_beq_false_of_ne s.sender (s.storageAddr 2) h_not]

/-- setManager reverts when the caller is not the timelock. -/
theorem setManager_reverts_when_not_timelock (s : ContractState) (newManager : Address)
  (h_not : s.sender ≠ s.storageAddr 1) :
  ∃ msg, (setManager newManager).run s = ContractResult.revert msg s := by
  simp [setManager, timelock, msgSender, getStorageAddr,
    Verity.require, Verity.bind, Bind.bind, Contract.run,
    address_beq_false_of_ne s.sender (s.storageAddr 1) h_not]

/-- setGuardian reverts when the caller is not the timelock; in particular slot 2
    cannot be rotated by a non-timelock. -/
theorem setGuardian_reverts_when_not_timelock (s : ContractState) (newGuardian : Address)
  (h_not : s.sender ≠ s.storageAddr 1) :
  ∃ msg, (setGuardian newGuardian).run s = ContractResult.revert msg s := by
  simp [setGuardian, timelock, msgSender, getStorageAddr,
    Verity.require, Verity.bind, Bind.bind, Contract.run,
    address_beq_false_of_ne s.sender (s.storageAddr 1) h_not]

/-- setGuardian reverts when `newGuardian = 0` (the zero-address guard), so the
    guardian slot can never be zeroed by a successful call — this is what keeps the
    `guardian_nonzero` invariant true under setGuardian. -/
theorem setGuardian_reverts_when_zero (s : ContractState) :
  ∃ msg, (setGuardian 0).run s = ContractResult.revert msg s := by
  by_cases h_tl : s.sender = s.storageAddr 1
  · refine ⟨"Guardian: zero guardian", ?_⟩
    simp [setGuardian, timelock, msgSender, getStorageAddr,
      Verity.require, Verity.bind, Bind.bind, Contract.run, h_tl]
  · exact setGuardian_reverts_when_not_timelock s 0 h_tl

/-! ## §7 Immutability + invariant preservation across EVERY function

  THEOREM 7. (a) Slot 0 (authenticator) and slot 1 (timelock) are unchanged by every
  function on its success path; (b) WellFormedState (esp. guardian slot 2 ≠ 0) is
  preserved by every function. setGuardian preserves it via the `newGuardian ≠ 0`
  require; the other three never write slot 2.
-/

/-! ### §7a Immutability of slots 0 and 1 -/

theorem addSolver_preserves_authenticator (s : ContractState) (solver : Address)
  (h_tl : s.sender = s.storageAddr 1) :
  ((addSolver solver).run s).snd.storageAddr 0 = s.storageAddr 0 :=
  addSolver_preserves_all_slots_when_timelock s solver h_tl 0

theorem addSolver_preserves_timelock (s : ContractState) (solver : Address)
  (h_tl : s.sender = s.storageAddr 1) :
  ((addSolver solver).run s).snd.storageAddr 1 = s.storageAddr 1 :=
  addSolver_preserves_all_slots_when_timelock s solver h_tl 1

theorem setManager_preserves_authenticator (s : ContractState) (newManager : Address)
  (h_tl : s.sender = s.storageAddr 1) (h_nz : newManager ≠ 0) :
  ((setManager newManager).run s).snd.storageAddr 0 = s.storageAddr 0 :=
  setManager_preserves_all_slots_when_timelock s newManager h_tl h_nz 0

theorem setManager_preserves_timelock (s : ContractState) (newManager : Address)
  (h_tl : s.sender = s.storageAddr 1) (h_nz : newManager ≠ 0) :
  ((setManager newManager).run s).snd.storageAddr 1 = s.storageAddr 1 :=
  setManager_preserves_all_slots_when_timelock s newManager h_tl h_nz 1

theorem setGuardian_preserves_authenticator (s : ContractState) (newGuardian : Address)
  (h_tl : s.sender = s.storageAddr 1) (h_nz : newGuardian ≠ 0) :
  ((setGuardian newGuardian).run s).snd.storageAddr 0 = s.storageAddr 0 :=
  (setGuardian_preserves_immutables_when_timelock s newGuardian h_tl h_nz).1

theorem setGuardian_preserves_timelock (s : ContractState) (newGuardian : Address)
  (h_tl : s.sender = s.storageAddr 1) (h_nz : newGuardian ≠ 0) :
  ((setGuardian newGuardian).run s).snd.storageAddr 1 = s.storageAddr 1 :=
  (setGuardian_preserves_immutables_when_timelock s newGuardian h_tl h_nz).2

theorem removeSolver_preserves_authenticator (s : ContractState) (solver : Address)
  (h_g : s.sender = s.storageAddr 2) :
  ((removeSolver solver).run s).snd.storageAddr 0 = s.storageAddr 0 :=
  removeSolver_preserves_all_slots_when_guardian s solver h_g 0

theorem removeSolver_preserves_timelock (s : ContractState) (solver : Address)
  (h_g : s.sender = s.storageAddr 2) :
  ((removeSolver solver).run s).snd.storageAddr 1 = s.storageAddr 1 :=
  removeSolver_preserves_all_slots_when_guardian s solver h_g 1

/-! ### §7b WellFormedState preservation -/

/-- addSolver leaves the state completely unchanged when authorized. -/
theorem addSolver_preserves_state (s : ContractState) (solver : Address)
  (h_tl : s.sender = s.storageAddr 1) :
  ((addSolver solver).run s).snd = s := by
  rw [addSolver_unfold s solver h_tl]; rfl

/-- setManager leaves the state completely unchanged when authorized. -/
theorem setManager_preserves_state (s : ContractState) (newManager : Address)
  (h_tl : s.sender = s.storageAddr 1) (h_nz : newManager ≠ 0) :
  ((setManager newManager).run s).snd = s := by
  rw [setManager_unfold s newManager h_tl h_nz]; rfl

/-- removeSolver leaves the state completely unchanged when authorized. -/
theorem removeSolver_preserves_state (s : ContractState) (solver : Address)
  (h_g : s.sender = s.storageAddr 2) :
  ((removeSolver solver).run s).snd = s := by
  rw [removeSolver_unfold s solver h_g]; rfl

theorem addSolver_preserves_wellformedness (s : ContractState) (solver : Address)
  (h : WellFormedState s) (h_tl : s.sender = s.storageAddr 1) :
  let s' := ((addSolver solver).run s).snd
  WellFormedState s' :=
  wf_of_state_eq _ _ _ (addSolver_preserves_state s solver h_tl) h

theorem setManager_preserves_wellformedness (s : ContractState) (newManager : Address)
  (h : WellFormedState s) (h_tl : s.sender = s.storageAddr 1) (h_nz : newManager ≠ 0) :
  let s' := ((setManager newManager).run s).snd
  WellFormedState s' :=
  wf_of_state_eq _ _ _ (setManager_preserves_state s newManager h_tl h_nz) h

theorem removeSolver_preserves_wellformedness (s : ContractState) (solver : Address)
  (h : WellFormedState s) (h_g : s.sender = s.storageAddr 2) :
  let s' := ((removeSolver solver).run s).snd
  WellFormedState s' :=
  wf_of_state_eq _ _ _ (removeSolver_preserves_state s solver h_g) h

/-- The interesting case: setGuardian writes slot 2, yet preserves well-formedness
    BECAUSE the `newGuardian ≠ 0` guard means the new guardian is nonzero. Slots 0,1
    and the context are untouched. -/
theorem setGuardian_preserves_wellformedness (s : ContractState) (newGuardian : Address)
  (h : WellFormedState s) (h_tl : s.sender = s.storageAddr 1) (h_nz : newGuardian ≠ 0) :
  let s' := ((setGuardian newGuardian).run s).snd
  WellFormedState s' := by
  obtain ⟨h_auth, h_tl_slot⟩ := setGuardian_preserves_immutables_when_timelock s newGuardian h_tl h_nz
  have h_g2 := setGuardian_sets_guardian_when_timelock s newGuardian h_tl h_nz
  have h_ctx : ((setGuardian newGuardian).run s).snd.sender = s.sender ∧
      ((setGuardian newGuardian).run s).snd.thisAddress = s.thisAddress := by
    rw [setGuardian_unfold s newGuardian h_tl h_nz]
    refine ⟨?_, ?_⟩ <;> simp [ContractResult.snd]
  refine ⟨?_, ?_, ?_, ?_, ?_⟩
  · rw [h_ctx.1]; exact h.sender_nonzero
  · rw [h_ctx.2]; exact h.contract_nonzero
  · rw [h_auth]; exact h.authenticator_nonzero
  · rw [h_tl_slot]; exact h.timelock_nonzero
  · rw [h_g2]; exact h_nz

/-! ## Summary of proven properties (all fully proven; no unproved gaps, no new trust assumptions)

The 7 security properties of the Echidna harness, proven over ALL states:

  1. constructor_sets_slots                       — constructor initialises 0,1,2
  2. constructor_preserves_wellformedness         — esp. guardian slot 2 ≠ 0
  3. addSolver  : *_meets_spec_when_timelock + *_preserves_all_slots + *_reverts_when_not_timelock
  4. setManager : *_meets_spec_when_timelock + *_preserves_all_slots + *_reverts_when_not_timelock (+ nonzero)
  5. setGuardian: *_sets_guardian + *_preserves_immutables + *_reverts_when_not_timelock + *_reverts_when_zero
  6. removeSolver: *_meets_spec_when_guardian + *_preserves_all_slots + *_reverts_when_not_guardian
  7. immutability of slots 0,1 across all four functions (§7a) +
     WellFormedState preserved by all four functions (§7b).

`echidna_*` ⟷ Lean cross-reference:
  echidna_no_solver_added     ⟷ addSolver_reverts_when_not_timelock (+ _unfold for the positive case)
  echidna_no_solver_removed   ⟷ removeSolver_reverts_when_not_guardian
  echidna_manager_never_set   ⟷ setManager_reverts_when_not_timelock
  echidna_guardian_unchanged  ⟷ setGuardian_reverts_when_not_timelock (only timelock rotates slot 2)
  echidna_timelock_unchanged  ⟷ {addSolver,setManager,setGuardian,removeSolver}_preserves_timelock (§7a)
  echidna_guardian_never_zero ⟷ {…}_preserves_wellformedness (§7b) via guardian_nonzero
-/

end Contracts.AllowListGuardian.Proofs
