# Vault policy module — invariant fuzzing (B2)

Stateful property fuzzing of the Phase-B `OphisVaultPolicyModule` drain
invariants. Two properties, three engines, all passing:

- **`turnover_within_cap`** — the leaky-bucket accumulator
  `turnoverSpentUsd` never exceeds `dailyUsdTurnoverCap`, under any sequence
  of rebalances, cancels, time warps, and oracle moves.
- **`no_bad_presignature`** — no policy-violating order (foreign receiver,
  non-zero signed fee, wrong appData, non-allowlisted / same token) is ever
  left holding a live presignature.

## Foundry invariant (CI-integrated, reproducible)

The durable, CI-runnable suite. Runs as part of `forge test`.

```bash
forge test --match-path 'test/vault/OphisVaultPolicyModuleInvariant.t.sol'
# heavier: FOUNDRY_INVARIANT_RUNS=512 FOUNDRY_INVARIANT_DEPTH=200 forge test ...
```

`test_handler_reaches_presign_path` proves the campaign is non-vacuous (a
clean order actually presigns; a bad one is rejected).

## Echidna

```bash
echidna test/fizz/vault/VaultPolicyEchidna.sol --contract VaultPolicyEchidna \
  --test-mode property --test-limit 40000 --seq-len 60 \
  --crytic-args "--compile-force-framework foundry"
```

## Medusa

Uses `medusa.json` in this directory. Medusa resolves `target` relative to the
CONFIG FILE's directory (it chdirs there), so the target is the bare
`VaultPolicyEchidna.sol` — do NOT reintroduce an absolute path: one pointing at
another worktree compiles and fuzzes THAT copy and reports green for code never
under test, and it cannot run in CI or on another machine.

```bash
medusa fuzz --config test/fizz/vault/medusa.json
```

Last run (2026-07-17): Foundry 128k calls · Echidna 40k iters · Medusa 146k
calls — all properties PASSING, 0 counterexamples.
