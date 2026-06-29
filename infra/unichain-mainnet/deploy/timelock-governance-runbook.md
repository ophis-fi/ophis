# Unichain AllowList governance — 24h timelock + fast eviction (#442 on chain 130)

Mirror of the OP migration (`docs/operations/allowlist-governance-runbook.md`)
for the sovereign Unichain (chain 130) deployment. Same design (Option A:
Guardian wrapper; the audited live AllowList impl is left untouched) and the
**same** `contracts/src/contracts/AllowListGuardian.sol` (chain-agnostic — the
authenticator/timelock/guardian are constructor args).

**Status:** NOT YET DEPLOYED. Gated on (a) a gas-only deployer EOA funded on 130
and (b) the 2-of-3 Safe signing the migration batch. Mandatory pre-deploy
dual-review (Codex gpt-5.5 + Trail of Bits) per the money-path rule — this is an
irreversible-ish mainnet governance change.

## What changes

Today the protocol Safe (`0xe049a64546fb8564CC4c7D64A0A1BAe00Aa801cF`, 2-of-3 on
130) is BOTH the AllowList `manager()` and the proxy upgrade admin — verified
on-chain 2026-06-29: proxy `manager()` == `owner()` == that Safe. After this:

- `AllowListGuardian` becomes the AllowList `manager()`:
  - `addSolver` / `setManager` / `setGuardian` callable ONLY by the timelock (24h delay)
  - `removeSolver` callable ONLY by the guardian (Safe), INSTANTLY (defensive eviction never delayed)
- The proxy upgrade admin (EIP-1967 owner) moves to the SAME TimelockController, so `upgradeTo` is 24h-delayed too.

## Addresses (Unichain mainnet, chain 130)

| | Address |
|---|---|
| AllowList proxy | `0x1002E12f2e7f848b20fe572F92133E467a5D010C` |
| Protocol Safe (proposer/executor/guardian) | `0xe049a64546fb8564CC4c7D64A0A1BAe00Aa801cF` |
| TimelockController (24h; proposer=executor=Safe) | `<TIMELOCK — fill after deploy>` |
| AllowListGuardian (manager; guardian=Safe) | `<GUARDIAN — fill after deploy>` |

## 0. Prereq — gas-only deployer

Fund a throwaway EOA on 130 with ~0.001 ETH (Unichain gas is ~nothing). It pays
gas only and holds NO authority: the Timelock's proposer/executor is the Safe
(not the deployer), and the deployer's admin role is renounced in step 1. Same
pattern as the OP deploy (keychain `ophis-megaeth-deployer`).

## 1. Deploy (run from contracts/)

OZ `TimelockController` is `^0.7.0`, the Guardian is `>=0.7.6`, so deploy each
with `forge create --use 0.7.6 --evm-version istanbul` (0.7.6 cannot target
cancun; istanbul matches the original GPv2 deployment). `contracts/foundry.toml`
has `deny_warnings`, so prefix with `FOUNDRY_DENY_WARNINGS=false`. The
`--constructor-args` flag is variadic — keep it LAST so it does not swallow
`--rpc-url`/`--account`.

```bash
cd contracts
RPC="$UNICHAIN_MAINNET_RPC"   # e.g. https://mainnet.unichain.org
SAFE=0xe049a64546fb8564CC4c7D64A0A1BAe00Aa801cF
AUTH=0x1002E12f2e7f848b20fe572F92133E467a5D010C

# 24h timelock, proposer = executor = the Safe.
FOUNDRY_DENY_WARNINGS=false forge create --use 0.7.6 --evm-version istanbul \
  --rpc-url "$RPC" --account <deployer> \
  node_modules/@openzeppelin/contracts/access/TimelockController.sol:TimelockController \
  --constructor-args 86400 "[$SAFE]" "[$SAFE]"        # -> TIMELOCK

FOUNDRY_DENY_WARNINGS=false forge create --use 0.7.6 --evm-version istanbul \
  --rpc-url "$RPC" --account <deployer> \
  src/contracts/AllowListGuardian.sol:AllowListGuardian \
  --constructor-args "$AUTH" <TIMELOCK> "$SAFE"       # -> GUARDIAN

# Renounce the deployer's admin role so ONLY the Safe (via the timelock) governs.
cast send <TIMELOCK> "renounceRole(bytes32,address)" \
  $(cast keccak "TIMELOCK_ADMIN_ROLE") <deployer> --rpc-url "$RPC" --account <deployer>
```

## 1b. Liveness + wiring assertions (MANDATORY before migration)

The guardian has NO escape hatch if the timelock is broken (fail-safe by design;
see the contract NatSpec). Prove BOTH that the timelock is live AND that the
guardian is wired to the right contracts BEFORE the irreversible migration.
Verify role membership by ENUMERATION (not `hasRole`) so an accidental extra or
open (incl. `address(0)`) proposer/executor is caught — same rigor the OP runbook
mandates for the rotate-Safe flow.

```bash
# Timelock: 24h delay + single-party (Safe-only) proposer + executor.
cast call <TIMELOCK> "getMinDelay()(uint256)" --rpc-url "$RPC"   # >= 86400
for ROLE_NAME in PROPOSER_ROLE EXECUTOR_ROLE; do
  ROLE=$(cast keccak "$ROLE_NAME")
  cast call <TIMELOCK> "getRoleMemberCount(bytes32)(uint256)" $ROLE --rpc-url "$RPC"       # == 1
  cast call <TIMELOCK> "getRoleMember(bytes32,uint256)(address)" $ROLE 0 --rpc-url "$RPC"  # == $SAFE
done
# Admin self-administers (deployer renounced): the SOLE admin is the Timelock itself.
ADMIN=$(cast keccak "TIMELOCK_ADMIN_ROLE")
cast call <TIMELOCK> "getRoleMemberCount(bytes32)(uint256)" $ADMIN --rpc-url "$RPC"         # == 1
cast call <TIMELOCK> "getRoleMember(bytes32,uint256)(address)" $ADMIN 0 --rpc-url "$RPC"    # == <TIMELOCK>

# Guardian: constructor wiring. A swapped/typo'd arg would hand the Auth manager()
# role to a wrapper that cannot govern the real allowlist — and the migration is
# irreversible, so verify the immutables BEFORE step 2.
cast call <GUARDIAN> "authenticator()(address)" --rpc-url "$RPC"  # == $AUTH (0x1002E12f...)
cast call <GUARDIAN> "timelock()(address)" --rpc-url "$RPC"       # == <TIMELOCK>
cast call <GUARDIAN> "guardian()(address)" --rpc-url "$RPC"       # == $SAFE (0xe049...01cF)

# Proxy: no dangling two-step manager proposal. The Auth has a two-step
# proposeManager/acceptManagership flow alongside setManager; a non-zero
# pendingManager could acceptManagership() INSTANTLY (no timelock). The batch's
# setManager(GUARDIAN) atomically clears pendingManager
# (GPv2AllowListAuthentication.setManager L119-122), but assert it is already 0
# so a fat-fingered/hostile proposeManager can't be left racing the migration.
cast call "$AUTH" "pendingManager()(address)" --rpc-url "$RPC"    # == 0x0000...0000
```

If any assertion fails, STOP — redeploy; do NOT migrate.

## 2. Migration — Safe TX batch (2-of-3, Safe Transaction Builder)

Import `allowlist-migration-safe-batch.json` (this dir; fill `<TIMELOCK>` /
`<GUARDIAN>` first), Tenderly-simulate, sign 2-of-3, execute. Order matters: set
the manager while the Safe still controls it, THEN hand off the proxy admin.

1. `authenticator.setManager(GUARDIAN)` — to `0x1002E12f…`, arg = `<GUARDIAN>`
2. `proxy.transferOwnership(TIMELOCK)` — to `0x1002E12f…`, arg = `<TIMELOCK>`

## 3. Verify after execution (cast, Unichain RPC)

```bash
cast call 0x1002E12f2e7f848b20fe572F92133E467a5D010C "manager()(address)" --rpc-url "$RPC"          # == GUARDIAN
cast call 0x1002E12f2e7f848b20fe572F92133E467a5D010C "owner()(address)"   --rpc-url "$RPC"          # == TIMELOCK
cast call 0x1002E12f2e7f848b20fe572F92133E467a5D010C "pendingManager()(address)" --rpc-url "$RPC"   # == 0x0 (no dangling proposal)
cast call <GUARDIAN> "guardian()(address)" --rpc-url "$RPC"                                         # == Safe
```

## 4. Day-2 governance flows

Identical to OP — see `docs/operations/allowlist-governance-runbook.md` §3
(add solver / upgrade = 24h SLOW via `TimelockController.schedule`; evict =
instant `AllowListGuardian.removeSolver` from the Safe; rotate Safe = the three
role surfaces; verify by ENUMERATION not `hasRole`).

## Notes

- Timelock delays ADDING capability + upgrades; never delays REMOVING a solver,
  so incident response stays instant.
- Single-party governance: the Safe is sole proposer/executor/canceller; the
  24h public delay is the only check (not prevention) — same posture as OP.
- Day-2 manager changes go through `AllowListGuardian.setManager` ONLY (it
  zero-checks the new manager and is 24h-timelocked). The proxy owner (the
  Timelock) can also drive the raw `setManager`/`proposeManager` on the proxy
  directly — also 24h-gated, but unguarded against `address(0)`; prefer the
  Guardian path. The instant `removeSolver` stays via the Guardian (Safe).
- The OZ TimelockController is the same `3.4.0-solc-0.7` as OP, so OP's
  PoC-verified "no sub-24h `executeBatch` bypass" conclusion ports unchanged.
  Re-verify if the OZ version ever differs.
- Blast radius: the SAME 2-of-3 Safe `0xe049…01cF` is proposer/executor/guardian
  on BOTH the OP and Unichain timelocks, so a 2-of-3 compromise reaches both
  chains' slow paths (24h-delayed on each). Acknowledged; not a migration blocker.
- Pre-deploy Codex + Trail of Bits review is mandatory; Tenderly-simulate the
  batch before signing.
