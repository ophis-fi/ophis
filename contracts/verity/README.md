# Formal verification — `AllowListGuardian`

Machine-checked proofs (Lean 4 / [Verity](https://github.com/lfglabs-dev/verity)) of the security
properties of [`AllowListGuardian.sol`](../src/contracts/AllowListGuardian.sol) — the **one
Ophis-custom contract** in the GPv2 suite (everything else is canonical, already-audited CoW
Protocol). It governs the solver allowlist, i.e. *who may settle batches*, so its access-control and
state-immutability properties are the most safety-critical on-chain invariants Ophis adds to the
base protocol.

`AllowListGuardian` already ships an [Echidna fuzz harness](../echidna/E2EAllowListGuardian.sol)
over 7 invariants. Fuzzing establishes *"no counterexample was found over sampled paths."* These
proofs establish the same invariants over **all reachable states** — machine-checked theorems, not
sampling.

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

The core safety property of the design — *"capability can only be reduced instantly; adding a solver
or handing off the manager always requires the 24h timelock"* — is exactly properties 3–7: the slow
path (`addSolver` / `setManager` / `setGuardian`) **reverts for any non-timelock caller**, and only
the fast, capability-*reducing* `removeSolver` is reachable by the guardian.

## Axiom footprint

Every theorem depends **only** on `propext` and `Quot.sound` — a strict subset of Lean's standard
`{propext, Classical.choice, Quot.sound}`. There is **no `sorryAx`** (no `sorry`/`admit`): nothing is
assumed, the proofs are complete. Confirm with the `#print axioms` step below.

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
cp -r /path/to/ophis/contracts/verity/Contracts/AllowListGuardian* Contracts/
printf '\nimport Contracts.AllowListGuardian\n' >> Contracts.lean
lake exe cache get      # prebuilt mathlib cache
lake build              # machine-checks every proof; expect "Build completed successfully."

# confirm no sorryAx:
printf 'import Contracts.AllowListGuardian\nopen Contracts.AllowListGuardian.Proofs\n#print axioms addSolver_reverts_when_not_timelock\n#print axioms setGuardian_preserves_wellformedness\n' > /tmp/ax.lean
lake env lean /tmp/ax.lean   # expect: depends on axioms: [propext, Quot.sound]
```

Pinned toolchain: [`lfglabs-dev/verity`](https://github.com/lfglabs-dev/verity) (MIT), Lean 4
`v4.22.0`. The `Contracts/` files here are a verified artifact — additive, verifying the *existing*
`AllowListGuardian.sol`; no Solidity is changed.
