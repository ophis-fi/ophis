# AllowList governance runbook — 24h timelock + fast eviction (#442)

**Status:** contract + tests landed; **on-chain migration NOT yet executed**
(requires the 2-of-3 Safe / Clement's Ledgers).
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
| TimelockController | _deployed in step 1 below_ |
| AllowListGuardian | _deployed in step 1 below_ |

## 1. Deploy (no hot key; deployer EOA only pays gas, holds no authority)

The TimelockController is OZ `^0.7.0` and the Guardian is `>=0.7.6`, so deploy
each with its own solc via `forge create` (a single forge script can't span
both pragmas):

```bash
# 24h timelock, proposer = executor = the Safe.
forge create --use 0.7.6 \
  lib/openzeppelin/contracts/access/TimelockController.sol:TimelockController \
  --constructor-args 86400 "[0xe049a64546fb8564CC4c7D64A0A1BAe00Aa801cF]" "[0xe049a64546fb8564CC4c7D64A0A1BAe00Aa801cF]" \
  --rpc-url "$OP_MAINNET_RPC" --account <deployer>   # -> TIMELOCK

forge create --use 0.7.6 src/contracts/AllowListGuardian.sol:AllowListGuardian \
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

**Rotate the guardian Safe (SLOW, 24h):** schedule `GUARDIAN.setGuardian(newSafe)` through the timelock.

## Notes

- The timelock delays *adding* capability and upgrades; it never delays
  *removing* a solver, so incident response stays instant.
- A compromised 2-of-3 still cannot add a solver or upgrade silently — every
  such action is visible on-chain for 24h, giving time to react.
- Pre-merge audit (Codex + sharp-edges) is mandatory for this mainnet
  governance change. Migration is irreversible-ish; double-check the batch in
  Tenderly before signing.
