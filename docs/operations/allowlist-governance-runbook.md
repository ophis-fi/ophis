# AllowList governance runbook — 24h timelock + fast eviction (#442)

**Status:** **DEPLOYED + MIGRATED + ENFORCED on OP mainnet (2026-06-05).** The
AllowList `manager()` is the Guardian and the proxy `owner()` is the Timelock
(verified on-chain). The steps below are retained as the deploy/migration record
and for re-running on another chain; §3 is the live day-2 governance flow.
**Design:** Option A (Guardian wrapper) — the audited live AllowList impl is
left untouched.

## What changes

Today the protocol Safe (`0xe049a64546fb8564CC4c7D64A0A1BAe00Aa801cF`, 2-of-3)
is both the AllowList `manager()` and the proxy upgrade admin, so solver-set
changes and upgrades are instant. After this change:

```
                         ┌──────────────────────────────┐
   addSolver / upgrade   │  TimelockController (24h)     │   slow, announced
   (SLOW, 24h delay)  ─▶ │  proposer+executor = Safe     │ ─▶ AllowList proxy
                         └──────────────────────────────┘
                         ┌──────────────────────────────┐
   removeSolver          │  AllowListGuardian           │   fast, instant
   (FAST, instant)    ─▶ │  guardian = Safe             │ ─▶ AllowList.removeSolver
                         └──────────────────────────────┘
```

- `AllowListGuardian` becomes the AllowList `manager()`.
  - `addSolver` / `setManager` / `setGuardian` are callable **only by the
    timelock** (24h delay).
  - `removeSolver` is callable **only by the guardian (Safe)**, **instantly** —
    defensive eviction of a compromised submitter is never delayed.
- The AllowList proxy upgrade admin (EIP-1967 owner) is transferred to the
  **same TimelockController**, so `upgradeTo` is also 24h-delayed.

## Addresses (OP mainnet)

| | Address |
|---|---|
| AllowList proxy | `0xAAA13bC6C1A505ccE6B4BF262fdDf4c703B9BD70` |
| Protocol Safe (proposer/executor/guardian) | `0xe049a64546fb8564CC4c7D64A0A1BAe00Aa801cF` |
| TimelockController (24h; proposer=executor=Safe) | `0x8fEe42897a0113BbeC86e4caCCaC5787D7AEC373` |
| AllowListGuardian (manager; guardian=Safe) | `0x327F8894caEd538525c3956Fcd694b374B26B6fC` |

## 1. Deploy (no hot key; deployer EOA only pays gas, holds no authority)

The TimelockController is OZ `^0.7.0` and the Guardian is `>=0.7.6`, so deploy
each with its own solc via `forge create` (a single forge script can't span
both pragmas):

Run from the `contracts/` dir. NOTE the `--evm-version istanbul` override: solc
0.7.6 cannot target `cancun` (the default in `contracts/foundry.toml`), and
istanbul matches the original GPv2 deployment.

```bash
cd contracts
# 24h timelock, proposer = executor = the Safe. OZ is under contracts/node_modules.
forge create --use 0.7.6 --evm-version istanbul \
  node_modules/@openzeppelin/contracts/access/TimelockController.sol:TimelockController \
  --constructor-args 86400 "[0xe049a64546fb8564CC4c7D64A0A1BAe00Aa801cF]" "[0xe049a64546fb8564CC4c7D64A0A1BAe00Aa801cF]" \
  --rpc-url "$OP_MAINNET_RPC" --account <deployer>   # -> TIMELOCK

forge create --use 0.7.6 --evm-version istanbul \
  src/contracts/AllowListGuardian.sol:AllowListGuardian \
  --constructor-args 0xAAA13bC6C1A505ccE6B4BF262fdDf4c703B9BD70 <TIMELOCK> 0xe049a64546fb8564CC4c7D64A0A1BAe00Aa801cF \
  --rpc-url "$OP_MAINNET_RPC" --account <deployer>   # -> GUARDIAN
```

After deploy, **renounce the deployer's TIMELOCK_ADMIN_ROLE** on the
TimelockController so only the Safe controls it (OZ self-administration leaves
the deployer admin otherwise):

```bash
cast send <TIMELOCK> "renounceRole(bytes32,address)" \
  $(cast keccak "TIMELOCK_ADMIN_ROLE") <deployer> --rpc-url "$OP_MAINNET_RPC" --account <deployer>
```

## 1b. Timelock liveness assertions (MANDATORY before migration)

The guardian has **no escape hatch** if the timelock is broken (fail-safe by
design — see the contract NatSpec). So prove the timelock is live and correctly
configured BEFORE handing it authority:

```bash
cast call <TIMELOCK> "getMinDelay()(uint256)" --rpc-url "$OP_MAINNET_RPC"   # must be >= 86400 (24h)
cast call <TIMELOCK> "hasRole(bytes32,address)(bool)" \
  $(cast keccak "PROPOSER_ROLE") 0xe049a64546fb8564CC4c7D64A0A1BAe00Aa801cF --rpc-url "$OP_MAINNET_RPC"  # true
cast call <TIMELOCK> "hasRole(bytes32,address)(bool)" \
  $(cast keccak "EXECUTOR_ROLE") 0xe049a64546fb8564CC4c7D64A0A1BAe00Aa801cF --rpc-url "$OP_MAINNET_RPC"  # true
# Confirm the deployer's admin role was renounced (only the timelock self-administers):
cast call <TIMELOCK> "hasRole(bytes32,address)(bool)" \
  $(cast keccak "TIMELOCK_ADMIN_ROLE") <deployer> --rpc-url "$OP_MAINNET_RPC"  # false
```

If any assertion fails, STOP — do not run the migration; redeploy the timelock.

## 2. Migration — Safe TX batch (2-of-3 Ledgers, via Safe Transaction Builder)

Build ONE batch with these two calls, sign with 2 of 3 Ledgers, execute.
Order matters: set the manager while the Safe still controls it, THEN hand off
the proxy admin.

1. **`authenticator.setManager(GUARDIAN)`** — to `0xAAA13bC6…BD70`,
   `setManager(address)`, arg = `<GUARDIAN>`.
2. **`proxy.transferOwnership(TIMELOCK)`** — to `0xAAA13bC6…BD70` (ERC-173
   proxy), `transferOwnership(address)`, arg = `<TIMELOCK>`.

**Verify after execution (cast, OP RPC):**
```bash
cast call 0xAAA13bC6C1A505ccE6B4BF262fdDf4c703B9BD70 "manager()(address)"   # == GUARDIAN
cast call 0xAAA13bC6C1A505ccE6B4BF262fdDf4c703B9BD70 "owner()(address)"     # == TIMELOCK
cast call <GUARDIAN> "guardian()(address)"                                  # == Safe
```

## 3. Day-2 governance flows

**Add a solver (SLOW, 24h):** from the Safe, `TimelockController.schedule(target=GUARDIAN, value=0, data=abi(addSolver(newSolver)), predecessor=0, salt, delay=86400)`; wait >= 24h; `execute(...)` with the same args.

**Upgrade the AllowList impl (SLOW, 24h):** same, target = the proxy, data = `upgradeTo(newImpl)`.

**Evict a solver (FAST, instant):** from the Safe, `AllowListGuardian.removeSolver(badSolver)` — no delay. Use this if the submitter key is compromised.

**Cancel a pending slow op:** from the Safe, `TimelockController.cancel(id)` (id = `hashOperation(...)`).

**Rotate the controlling Safe (SLOW, 24h) — THREE role surfaces, not one.** The Safe controls the system in three places; replacing it means rotating all three, or the OLD Safe keeps the slow path:
1. **Guardian fast-path:** schedule `GUARDIAN.setGuardian(newSafe)` through the timelock.
2. **Timelock proposer:** schedule `TIMELOCK.grantRole(PROPOSER_ROLE, newSafe)` then `TIMELOCK.revokeRole(PROPOSER_ROLE, oldSafe)`.
3. **Timelock executor:** schedule `TIMELOCK.grantRole(EXECUTOR_ROLE, newSafe)` then `TIMELOCK.revokeRole(EXECUTOR_ROLE, oldSafe)`.
(`PROPOSER_ROLE`/`EXECUTOR_ROLE` = `cast keccak "PROPOSER_ROLE"` / `"EXECUTOR_ROLE"`.) Until all three are done, the old Safe retains slow-path control.

**Verify by ENUMERATION, not `hasRole`.** `hasRole(role, newSafe)==true` only proves the new Safe *has* the role — it cannot prove it's the *sole* holder, so a stale old Safe, the deployer, an `address(0)` open executor, or any rogue grant would pass unnoticed and keep slow-path control. For each of PROPOSER and EXECUTOR, assert the member set is **exactly `[newSafe]`**:
```bash
ROLE=$(cast keccak "PROPOSER_ROLE")   # then repeat for EXECUTOR_ROLE
cast call <TIMELOCK> "getRoleMemberCount(bytes32)(uint256)" $ROLE   # must == 1
cast call <TIMELOCK> "getRoleMember(bytes32,uint256)(address)" $ROLE 0   # must == newSafe
```
Also re-check `GUARDIAN.guardian() == newSafe` and that TIMELOCK_ADMIN_ROLE still has exactly one member (the Timelock itself). This mirrors the weekly `safe-drift-check` cron's enumeration.

## Notes

- The timelock delays *adding* capability and upgrades; it never delays
  *removing* a solver, so incident response stays instant.
- A compromised 2-of-3 cannot add a solver or upgrade **silently or instantly** —
  every such action is scheduled on-chain and **delayed a full 24h** before it can
  execute, giving observers time to react (and the immutable Settlement/Vault cap
  the blast radius regardless). It is a *public-delay* protection, **not
  prevention**: a compromised Safe can still push a change through after 24h.
- **Single-party governance (verified 2026-06-05).** The Safe is the **sole**
  PROPOSER, **sole** EXECUTOR, and (OZ 3.4 `cancel` = `onlyRole(PROPOSER_ROLE)`)
  **sole** canceller; the Timelock self-administers; EXECUTOR is not open. So there
  is **no independent guardian/canceller veto** over a malicious queued op — the
  24h window is the only check. A future hardening is a separate canceller
  (CANCELLER role / a watcher Safe) that can veto within the window.
- **The 24h delay genuinely holds (PoC-verified 2026-06-05).** OZ 3.4.0's
  `executeBatch` checks readiness in `_afterCall` (after the calls) rather than
  `_beforeCall`, but this is **not** a sub-24h bypass: the entry op's `_afterCall`
  `isOperationReady` gate is unsatisfiable for a fresh id (its timestamp can only
  be `0`, `1`=DONE, or `now+≥86400`), and self-scheduling the entry batch is a
  keccak fixed-point (infeasible). A Forge PoC attempting the one-tx bypass reverts
  with "operation is not ready"; the op only executes after a 24h warp. Re-verify
  if the Timelock is ever redeployed on a different OZ version.
- Pre-merge audit (Codex + sharp-edges) is mandatory for this mainnet
  governance change. Migration is irreversible-ish; double-check the batch in
  Tenderly before signing.
