# Formal verification — `AllowListGuardian`

Machine-checked proofs (Lean 4 / [Verity](https://github.com/lfglabs-dev/verity)) of a model of
[`AllowListGuardian.sol`](../src/contracts/AllowListGuardian.sol). It governs the solver allowlist,
i.e. *who may settle batches*. The model covers its access-control and state-immutability properties.

`AllowListGuardian` already ships an [Echidna fuzz harness](../echidna/E2EAllowListGuardian.sol)
over 7 invariants. Fuzzing establishes *"no counterexample was found over sampled paths."* These
proofs establish the modeled invariants for states satisfying each theorem's assumptions.
They do not establish equivalence between the model and deployed Solidity bytecode.

## What is proven

The contract is ported to the Verity EDSL (`Contracts/AllowListGuardian/AllowListGuardian.lean`) with
three storage slots — `authenticator` (slot 0), `timelock` (slot 1), `guardian` (slot 2) — and
proven (`Proofs/Basic.lean`, 38 theorems) to satisfy:

| # | Property | Key theorems |
|---|---|---|
| 1 | Constructor sets the three roles | `constructor_sets_slots` |
| 2 | Constructor preserves well-formedness (guardian ≠ 0) | `constructor_preserves_wellformedness` |
| 3 | `addSolver` takes effect **only** under the timelock; otherwise reverts | `addSolver_meets_spec_when_timelock`, `addSolver_reverts_when_not_timelock`, `addSolver_preserves_all_slots_when_timelock` |
| 4 | `setManager` only under the timelock + nonzero target; otherwise reverts | `setManager_meets_spec_when_timelock`, `setManager_reverts_when_not_timelock` |
| 5 | `setGuardian` only under the timelock + nonzero; sets slot 2; preserves slots 0/1 | `setGuardian_sets_guardian_when_timelock`, `setGuardian_preserves_immutables_when_timelock`, `setGuardian_reverts_when_not_timelock`, `setGuardian_reverts_when_zero` |
| 6 | `removeSolver` only under the guardian; otherwise reverts | `removeSolver_meets_spec_when_guardian`, `removeSolver_reverts_when_not_guardian` |
| 7 | `authenticator` + `timelock` immutable under every function; guardian ≠ 0 preserved by every function | `{addSolver,setManager,setGuardian,removeSolver}_preserves_{authenticator,timelock}`, `*_preserves_wellformedness` |

The core modeled safety property is that adding a solver or handing off the manager requires
the timelock role, while the guardian can remove a solver. Properties 3–7 establish that the slow
path (`addSolver` / `setManager` / `setGuardian`) **reverts for any non-timelock caller**, and only
the fast, capability-*reducing* `removeSolver` is reachable by the guardian. The timelock's delay
and the external authenticator's behavior are outside this model.

## Axiom footprint

All 38 theorems depend **only** on Lean's standard axioms
`{propext, Classical.choice, Quot.sound}`. There is **no `sorryAx`** (no `sorry`/`admit`) or custom
axiom. Confirm with the `#print axioms` step below.

## Modeling note (honest scope)

`addSolver`, `setManager`, and `removeSolver` forward to the external `authenticator` (the canonical,
audited CoW `GPv2AllowListAuthentication`) as their last statement, reached only if the preceding role
`require` passed. The EDSL models each by its **access-control guard**: the proofs establish that the
function **reverts** unless the caller holds the role (so it cannot forward), and otherwise leaves the
guardian's own storage untouched. The external authenticator's behavior is out of scope — it is the
audited CoW contract. This is the strongest honest statement of "the forward is gated by role." The
guardian's own protected state (the three slots) is verified completely.

## Reproduce

These proofs build against the Verity framework (Lean 4 + mathlib), not in this repo's CI. To
machine-check them yourself:

```sh
git clone https://github.com/lfglabs-dev/verity && cd verity
git checkout 98533b72d2c93546e135d6b9e3aac08c5dbc06a8
cp -r /path/to/ophis/contracts/verity/Contracts/AllowListGuardian* Contracts/
printf '\nimport Contracts.AllowListGuardian\n' >> Contracts.lean
lake exe cache get      # prebuilt mathlib cache
lake build Contracts    # explicitly include the contract proofs, not just the default Verity target

# inspect every theorem's axioms; none should include sorryAx:
printf 'import Contracts.AllowListGuardian\n' > /tmp/ax.lean
sed -n 's/^theorem \([A-Za-z0-9_]*\).*/#print axioms Contracts.AllowListGuardian.Proofs.\1/p' \
  Contracts/AllowListGuardian/Proofs/Basic.lean >> /tmp/ax.lean
lake env lean /tmp/ax.lean
```

Verified framework: [`lfglabs-dev/verity` at `98533b72d2c93546e135d6b9e3aac08c5dbc06a8`](https://github.com/lfglabs-dev/verity/tree/98533b72d2c93546e135d6b9e3aac08c5dbc06a8) (MIT), Lean 4
`v4.31.0`. The `Contracts/` files here are a verified artifact — additive, verifying the *existing*
`AllowListGuardian.sol`; no Solidity is changed.
