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
| TimelockController (24h; proposer=executor=Safe) | `0xFC2A6a54122E6D0a598CAe7453DD61263c1065Ed` |
| AllowListGuardian (manager; guardian=Safe) | `0x4821A534FB11ea4bb2f88d48B13A498A80462e64` |

**Deployed 2026-06-29** (gas-only deployer `0x40a8D159Bdf9DD76d074cA6C6d949E0575ef9e7f`, now renounced of all authority):
TimelockController tx `0x7f0e556792db269787e1a36257df72ea8dc37f067ae6bc832678f83679703fbb`;
AllowListGuardian tx `0xf72a8d705566e6a9a9dbb992ff7109bbdc130420820d28998b0264cb7ef2b7c9`;
admin renounce tx `0x3302335ccb463cc0ff4a8ca8f751a8cc596d323bb580773e4118bc698f4ce396`.
All 11 pre-migration assertions + the batch pre-sign gate PASS, and an anvil
fork-sim of the exact batch proved the end-state + security properties (SIGN).
The migration batch `allowlist-migration-safe-batch.FILLED-130.json` awaits the
2-of-3 Safe signature.

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
set -euo pipefail
cd contracts
: "${UNICHAIN_MAINNET_RPC:?set UNICHAIN_MAINNET_RPC, e.g. https://mainnet.unichain.org}"
RPC="$UNICHAIN_MAINNET_RPC"
SAFE=0xe049a64546fb8564CC4c7D64A0A1BAe00Aa801cF
AUTH=0x1002E12f2e7f848b20fe572F92133E467a5D010C
# FATAL chain gate: the migration batch (step 2) is hard-pinned to chain 130. A
# wrong/unset RPC would deploy to the WRONG chain, pass every (chain-agnostic) 1b
# read-back, then setManager on the real chain-130 Auth would point manager() at a
# codeless address = permanent brick. Verify the chain FIRST.
test "$(cast chain-id --rpc-url "$RPC")" = 130 || { echo "RPC is not chain 130 — ABORT" >&2; exit 1; }

# 24h timelock, proposer = executor = the Safe. The Safe is inlined LITERALLY in the
# array brackets (set -u also guards $VAR, but a literal removes the "[]" empty-set
# brick risk entirely if the brackets are ever hand-edited).
FOUNDRY_DENY_WARNINGS=false forge create --use 0.7.6 --evm-version istanbul \
  --rpc-url "$RPC" --account <deployer> \
  node_modules/@openzeppelin/contracts/access/TimelockController.sol:TimelockController \
  --constructor-args 86400 "[0xe049a64546fb8564CC4c7D64A0A1BAe00Aa801cF]" "[0xe049a64546fb8564CC4c7D64A0A1BAe00Aa801cF]"   # -> TIMELOCK

FOUNDRY_DENY_WARNINGS=false forge create --use 0.7.6 --evm-version istanbul \
  --rpc-url "$RPC" --account <deployer> \
  src/contracts/AllowListGuardian.sol:AllowListGuardian \
  --constructor-args 0x1002E12f2e7f848b20fe572F92133E467a5D010C <TIMELOCK> 0xe049a64546fb8564CC4c7D64A0A1BAe00Aa801cF   # -> GUARDIAN

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
mandates for the rotate-Safe flow. Run these AFTER step 1's deployer-admin
renounce: pre-renounce, OZ grants `TIMELOCK_ADMIN_ROLE` to BOTH the deployer and
the timelock (count 2), so `getRoleMember(ADMIN,0)` would be the deployer.

```bash
# Chain + current custody re-check, on the SAME RPC the batch will use — do NOT
# trust the multi-day-old snapshot. The Safe must STILL own both surfaces the
# batch touches (the proxy's original owner in the deploy record was the gas
# deployer 0xBeC5B03f..., later transferred to the Safe — re-confirm that holds).
test "$(cast chain-id --rpc-url "$RPC")" = 130 || { echo "not chain 130 — ABORT" >&2; exit 1; }
cast call "$AUTH" "owner()(address)" --rpc-url "$RPC"    # == $SAFE (0xe049...01cF) — Safe still controls the proxy admin
cast call "$AUTH" "manager()(address)" --rpc-url "$RPC"  # == $SAFE — Safe still controls the manager role

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

Fill `<GUARDIAN>` / `<TIMELOCK>` in `allowlist-migration-safe-batch.json` with the
step-1-deployed, 1b-asserted addresses. Order matters: set the manager while the
Safe still controls it, THEN hand off the proxy admin.

1. `authenticator.setManager(GUARDIAN)` — to `0x1002E12f…`, arg = `<GUARDIAN>`
2. `proxy.transferOwnership(TIMELOCK)` — to `0x1002E12f…`, arg = `<TIMELOCK>`

**Pre-sign gate (HARD — run on the FILLED batch before signing).** Neither call
zero-checks: `EIP173Proxy.transferOwnership` is a raw owner sstore (a zero/wrong
owner makes `onlyOwner` permanently unsatisfiable = upgrade authority bricked) and
`GPv2AllowListAuthentication.setManager` is a raw assignment (only the not-yet-
installed Guardian zero-guards). Call 2 (`transferOwnership`) is the unguarded,
IRREVERSIBLE leg. A placeholder/zero/valid-but-WRONG address bricks or backdoors
governance permanently, so gate the exact bytes that will be signed:

```bash
B=allowlist-migration-safe-batch.json
lc() { tr 'A-Z' 'a-z'; }
# (a) no unfilled placeholder survived the edit.
grep -q '<' "$B" && { echo "placeholders remain in $B — ABORT" >&2; exit 1; }
# (b) the two address args EXACTLY equal the deployed GUARDIAN / TIMELOCK (a valid-
#     but-wrong address bricks just as badly as a zero — assert exact equality).
M=$(jq -r '.transactions[0].contractInputsValues.manager_' "$B" | lc)
O=$(jq -r '.transactions[1].contractInputsValues.newOwner'  "$B" | lc)
[ "$M" = "$(printf %s <GUARDIAN> | lc)" ] || { echo "tx0 manager_ != GUARDIAN — ABORT" >&2; exit 1; }
[ "$O" = "$(printf %s <TIMELOCK> | lc)" ] || { echo "tx1 newOwner != TIMELOCK — ABORT" >&2; exit 1; }
# (c) methods + targets are exactly what we intend.
[ "$(jq -r '.transactions[0].contractMethod.name' "$B")" = setManager ]        || { echo "tx0 not setManager" >&2; exit 1; }
[ "$(jq -r '.transactions[1].contractMethod.name' "$B")" = transferOwnership ] || { echo "tx1 not transferOwnership" >&2; exit 1; }
for i in 0 1; do
  [ "$(jq -r ".transactions[$i].to" "$B" | lc)" = 0x1002e12f2e7f848b20fe572f92133e467a5d010c ] || { echo "tx$i wrong target" >&2; exit 1; }
done
echo "batch pre-sign gate: PASS"
```

Then MANDATORY state-diff simulation (Tenderly, or `anvil --fork "$RPC"` + apply
the batch): confirm post-sim `owner()==<TIMELOCK>` and `manager()==<GUARDIAN>`
BEFORE the 2-of-3 signs. The batch is an atomic Safe multiSend, so a revert rolls
back both calls — but a wrong-address that does NOT revert is the irreversible
case the gate above exists to catch. Only then sign + execute.

## 3. Verify after execution (cast, Unichain RPC)

```bash
cast call 0x1002E12f2e7f848b20fe572F92133E467a5D010C "manager()(address)" --rpc-url "$RPC"          # == GUARDIAN
cast call 0x1002E12f2e7f848b20fe572F92133E467a5D010C "owner()(address)"   --rpc-url "$RPC"          # == TIMELOCK
cast call 0x1002E12f2e7f848b20fe572F92133E467a5D010C "pendingManager()(address)" --rpc-url "$RPC"   # == 0x0 (no dangling proposal)
cast call <GUARDIAN> "guardian()(address)" --rpc-url "$RPC"                                         # == Safe
cast call <GUARDIAN> "timelock()(address)" --rpc-url "$RPC"                                         # == <TIMELOCK> (self-consistent end-to-end)
cast call <GUARDIAN> "authenticator()(address)" --rpc-url "$RPC"                                    # == 0x1002E12f...
```

Then record the end-state so a future audit/stats run can't mis-flag the manager
row: add `contracts/deployments/unichain-mainnet/NOTE-allowlist-upgrade.md`
(mirror the OP one) noting Proxy `0x1002E12f...`, Impl `0x2Ddcc99c...`,
`manager()==<GUARDIAN>`, `owner()==<TIMELOCK>`, the slow/fast-path model, and the
regression warning: do NOT point `manager()` back at the bare Safe (it removes the
24h delay).

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
