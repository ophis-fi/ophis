# Fee-treasury ops runbook (OphisFeeLiquidator)

**Status: CODE ONLY. Nothing in this runbook has been executed on-chain.**
Every step below that deploys, schedules, signs, or broadcasts is an OWNER
ceremony: it is performed by the operator (protocol-Safe signers + the infra
host owner), never by an agent. Agents prepare payloads; humans sign.

Scope: the fee-ops Wave 2 deliverable (build-plan section 4.7, decisions
52-57 with the recommended defaults). Two operations split across two trust
tiers:

1. **sweep** (LIQUIDATOR hot key): move accrued CIP-75 fees from the OP
   Settlement contract to the immutable fee Safe (`OphisFeeLiquidator.sweep`,
   amount 0 = full balance, address(0) = native ETH). Safe for a hot key
   because the destination is pinned and unbypassable.
2. **consolidate** (OWNER Safe only): swap multi-denomination fee dust in
   place into WETH with a mandatory `amountOutMin` floor
   (`OphisFeeLiquidator.consolidate`). This routes through an arbitrary
   allowlisted venue with caller-supplied calldata, so it carries the same
   trust as `setVenue` and is OWNER-ONLY: a hot key could otherwise pass
   `amountOutMin = 1` and venue calldata paying an attacker. The 100 bps
   runner cap binds the off-chain runner, NOT a direct contract call, which
   is why the contract itself gates the call to the owner Safe. Consolidation
   is also DISABLED at launch: the venue allowlist deploys empty (decision
   52); activation and execution are BOTH owner Safe transactions, no
   redeploy.

Ported pattern: OdosRouterV3 `liquidatorAddress` / `transferRouterFunds` /
`swapRouterFunds` (MIT, notice retained in the contract header), narrowed:
destination pinned to the immutable fee Safe, venues + output tokens
owner-allowlisted, `amountOutMin > 0` mandatory.

## 1. Roles and addresses

| Role | Address | Notes |
|---|---|---|
| Settlement (OP) | `0x310784c7FCE12d578dA6f53460777bAc9718B859` | fees accrue here |
| Fee Safe | `0x858f0F5eE954846D47155F5203c04aF1819eCeF8` | IMMUTABLE in the contract |
| Protocol Safe (owner) | `0xe049a64546fb8564CC4c7D64A0A1BAe00Aa801cF` | 2-of-3; admin + fallback ops |
| AllowList proxy | `0xAAA13bC6C1A505ccE6B4BF262fdDf4c703B9BD70` | solver gate |
| TimelockController (24h) | `0x8fEe42897a0113BbeC86e4caCCaC5787D7AEC373` | addSolver goes through here |
| AllowListGuardian | `0x327F8894caEd538525c3956Fcd694b374B26B6fC` | instant removeSolver |
| Driver-submitter EOA | `0x92B9bE5e96795E8630fDC61efb0e705E75b1A1B1` | UNTOUCHED by fee ops (v2 goal) |
| OphisFeeLiquidator | _record after deploy_ | the contract IS the solver |
| Fee-ops key | _record after keygen_ | `liquidator()`; host key file |

Sepolia rehearsal chain (optimism-sepolia, chainId 11155420):

| | Address |
|---|---|
| Settlement | `0x0864b65F1EFe752a699d119Ae0419E7331a8Bfce` |
| AllowList proxy | `0x9eFDcC2770Af6837B285702d386D558BD1066BA8` |

Control relationships, worth internalizing before any ceremony:

- The **contract** is the allowlisted solver, not the ops key. The guardian's
  instant `removeSolver(liquidator)` kills both sweep and consolidate in one
  Safe transaction regardless of key state.
- The **ops key** (liquidator role) reaches ONLY `sweep`, whose destination is
  the immutable fee Safe. It cannot call `consolidate` (owner-only), cannot
  change the destination, the venue set, or its own successor.
- The **owner Safe** can pause the key (`setLiquidator(0)`), rotate it,
  allowlist venues/output tokens, and EXECUTE consolidations (venue routing is
  an owner capability, not a hot-key one). All instant except adding solver
  capability, which is the ONLY 24h-delayed action.

## 2. Ops-key custody (decision 55)

Same pattern as the driver-submitter key (see
`submitter-pk-backup-runbook.md` for the backup ritual, which applies
verbatim to this key):

- Generate OFFLINE on the infra host: `cast wallet new` into
  `/Users/ophis-driver/.config/fee-ops.key` (file contains `0x` + 64 hex,
  no trailing newline), `chmod 0400`, owned by the ops user.
- The key needs a small gas float only (0.005 ETH on OP is months of
  sweeps). It never custodies swept funds.
- **Manual runs first** with the Telegram nag below; automation (which makes
  the key hot) only after the routine is boring, and that flip is an owner
  decision recorded here when taken.
- Telegram nag: add a weekly reminder via the existing cron convention
  (`infra/shared/cron/`, mirror the settlement-anomaly plist) that runs
  `check-settlement-buffer.sh` and messages the buffer + last-sweep age.
  The nag never signs anything.
- Compromise response: §8. The key is deliberately low-value; the worst an
  attacker holding ONLY this key can do is `sweep` fees to the immutable fee
  Safe (destination pinned, no loss). The key CANNOT `consolidate` (owner-only)
  so it never touches the arbitrary-venue routing path. Rotation is one Safe
  transaction (`setLiquidator`).

## 3. What ships in the repo (already merged when you read this)

- `contracts/src/contracts/OphisFeeLiquidator.sol` (contract; MIT notice)
- `contracts/script/DeployFeeLiquidator.s.sol` (deploy script)
- `contracts/test/OphisFeeLiquidator/` (forge suite incl. fuzz)
- `contracts/echidna/E2EFeeLiquidator.sol` (weekly fuzz lane, echidna.yml)
- `infra/optimism-mainnet/scripts/sweep-to-safe.sh` (v2 runner, cast-send)
- `infra/optimism-mainnet/scripts/consolidate-fee-dust.sh` (emits an owner
  Safe Transaction Builder payload; does NOT sign; inert until venue
  activation)
- `infra/optimism-mainnet/scripts/settlement-anomaly-watch.sh` (solver-SET
  aware; `FEE_LIQUIDATOR` env; now REQUIRES `TELEGRAM_BOT_TOKEN_FILE` +
  `TELEGRAM_CHAT_ID`, fails loud without them, and heartbeats)
- `infra/optimism-mainnet/scripts/check-settlement-buffer.sh` (liquidator +
  last-sweep-age probe)
- `contracts/script/SweepSettlementBuffer.s.sol` (v1, KEPT as DR fallback,
  decision 56; do not delete)

## 4. Sepolia rehearsal (MANDATORY before mainnet)

Goal: walk the full lifecycle once where mistakes are free. On
optimism-sepolia the allowlist manager is operator-controlled (verify with
`cast call <proxy> "manager()(address)"`), so the timelock leg is rehearsed
mechanically (§5 payloads) but executed directly by the manager.

```bash
export RPC=<optimism-sepolia rpc>
export REHEARSAL_EOA=<your funded sepolia EOA>

# 4.1 stand-ins: rehearsal "fee safe" = a second EOA you control;
#     rehearsal ops key = a third key file.
cast wallet new   # -> REHEARSAL_SAFE
cast wallet new   # -> fee-ops-rehearsal.key -> REHEARSAL_OPS

# 4.2 deploy. Project-scoped OFL_* env names (never bare SETTLEMENT/OWNER,
#     which collide with ambient shell state). On a non-OP chain the mainnet
#     defaults refuse to resolve, so ALL three addresses are explicit; an EOA
#     owner is allowed off mainnet (loud WARN only). OFL_CONFIRM=1 is required
#     to broadcast.
cd contracts
OFL_SETTLEMENT=0x0864b65F1EFe752a699d119Ae0419E7331a8Bfce \
OFL_FEE_SAFE=$REHEARSAL_SAFE OFL_OWNER=$REHEARSAL_EOA OFL_LIQUIDATOR=$REHEARSAL_OPS \
OFL_CONFIRM=1 PRIVATE_KEY=<deployer pk> \
forge script DeployFeeLiquidator --rpc-url "$RPC" --broadcast
# record -> LIQ

# 4.3 allowlist the CONTRACT as a solver (direct manager call on sepolia)
cast send 0x9eFDcC2770Af6837B285702d386D558BD1066BA8 "addSolver(address)" "$LIQ" \
  --rpc-url "$RPC" --private-key <manager pk>
cast call 0x9eFDcC2770Af6837B285702d386D558BD1066BA8 "isSolver(address)(bool)" "$LIQ" --rpc-url "$RPC"  # true

# 4.4 fund the Settlement with rehearsal fees: send it a test ERC20 +
#     a little native ETH (Settlement has an open receive()).

# 4.5 sweep, dry-run then broadcast, via the real runner:
OPHIS_RPC="$RPC" FEE_LIQUIDATOR="$LIQ" \
OPHIS_FEE_OPS_KEY_PATH=<fee-ops-rehearsal.key> \
TOKENS=<testToken>,0x0000000000000000000000000000000000000000 MIN_BASE_UNITS=1,1 \
  ./infra/optimism-mainnet/scripts/sweep-to-safe.sh
# NOTE: the runner pins the MAINNET settlement + Safe; on sepolia it will
# ABORT at the pin check, which is the DESIGNED behavior. For the rehearsal
# either call the contract with cast directly:
cast send "$LIQ" "sweep(address[],uint256[])" "[<testToken>,0x0000000000000000000000000000000000000000]" "[0,0]" \
  --rpc-url "$RPC" --private-key <rehearsal ops pk>
# and verify REHEARSAL_SAFE received both balances.

# 4.6 pause/unpause: setLiquidator(0) from OWNER; confirm the ops key sweep
#     gets "OFL: caller not ops"; setLiquidator back.

# 4.7 consolidation dry ceremony. consolidate() is OWNER-ONLY, so the OWNER
#     key runs it (NOT the ops key). First prove the ops key is rejected, then
#     deploy the forge-test MockVenueRouter, setVenue + setOutputToken from
#     OWNER, run one consolidate from OWNER with hand-built calldata and
#     amountOutMin, then setVenue(false).
cast send "$LIQ" "consolidate((address,uint256)[],address,uint256,address,bytes)" \
  "[(<testToken>,0)]" <tokenOut> 1 <venue> 0x --rpc-url "$RPC" --private-key <rehearsal ops pk>
#   ^ MUST revert "OFL: caller not owner" (proves the hot key cannot consolidate)
forge create test/OphisFeeLiquidator/Mocks.sol:MockVenueRouter --rpc-url "$RPC" --private-key <pk>
#   then setVenue/setOutputToken and the real consolidate() are signed by the
#   OWNER key (on mainnet this is the Safe; see §7).

# 4.8 rollback rehearsal: removeSolver from the manager; confirm sweep now
#     reverts "GPv2: not a solver".
```

Exit criteria: every step above behaved as documented, including BOTH abort
paths (pin-check abort, paused abort). Record tx hashes in this file's
rehearsal log (§10).

## 5. Mainnet deployment (owner ceremony)

Deployment itself grants no authority (the contract only matters once the
timelock adds it as a solver), so the deployer is any gas-funded EOA.

On chain 10 the mainnet defaults (settlement, fee Safe, owner Safe) resolve
automatically and OWNER/FEE_SAFE are asserted to have code (they are Safes);
`OFL_LIQUIDATOR` is the only address you pass. `OFL_CONFIRM=1` is REQUIRED to
broadcast, so a dry-run cannot accidentally send.

```bash
cd contracts
# dry-run first (NO OFL_CONFIRM, so it prints resolved args and does NOT send):
OFL_LIQUIDATOR=<fee-ops EOA> forge script DeployFeeLiquidator \
  --rpc-url "$OP_MAINNET_RPC" --sender <deployer>
# review the printed Chain id / Owner / Fee Safe / Liquidator, THEN live:
OFL_CONFIRM=1 OFL_LIQUIDATOR=<fee-ops EOA> PRIVATE_KEY=<deployer pk> \
  forge script DeployFeeLiquidator --rpc-url "$OP_MAINNET_RPC" --broadcast
```

Post-deploy verification (all must match before the timelock ceremony):

```bash
cast call $LIQ "settlement()(address)" --rpc-url "$OP_MAINNET_RPC"  # 0x310784c7…B859
cast call $LIQ "feeSafe()(address)"    --rpc-url "$OP_MAINNET_RPC"  # 0x858f0F5e…CeF8
cast call $LIQ "owner()(address)"      --rpc-url "$OP_MAINNET_RPC"  # 0xe049a6…01cF
cast call $LIQ "liquidator()(address)" --rpc-url "$OP_MAINNET_RPC"  # fee-ops EOA
cast call $LIQ "venueAllowed(address)(bool)" 0x6131B5fae19EA4f9D964eAc0408E4408b66337b5 --rpc-url "$OP_MAINNET_RPC"  # false (decision 52)
```

Then record the address:

- `contracts/deployments/optimism-mainnet/OphisFeeLiquidator.json` (address,
  txHash, constructor args, abi, mirroring the sibling artifacts)
- `contracts/networks.json` under a new `OphisFeeLiquidator` key, chain `10`
- the two placeholder rows in §1
- verify source on the OP explorer (`forge verify-contract`, LGPL-3.0-or-later)

## 6. The 24h timelock addSolver ceremony (owner ceremony)

This is the §3 day-2 flow of `allowlist-governance-runbook.md`, applied to
the liquidator contract. Two Safe transactions, at least 24h apart.

Preparation (any machine, read-only):

```bash
LIQ=<deployed OphisFeeLiquidator>
GUARDIAN=0x327F8894caEd538525c3956Fcd694b374B26B6fC
TIMELOCK=0x8fEe42897a0113BbeC86e4caCCaC5787D7AEC373
SALT=$(cast keccak "ophis-fee-liquidator-addsolver-v1")   # any unique bytes32; record it
DATA=$(cast calldata "addSolver(address)" "$LIQ")

# operation id, for status checks and for cancel:
cast call $TIMELOCK \
  "hashOperation(address,uint256,bytes,bytes32,bytes32)(bytes32)" \
  "$GUARDIAN" 0 "$DATA" 0x0000000000000000000000000000000000000000000000000000000000000000 "$SALT" \
  --rpc-url "$OP_MAINNET_RPC"    # -> OP_ID
```

**Safe TX 1, schedule** (Safe Transaction Builder, 2-of-3 Ledgers):

- To: `0x8fEe42897a0113BbeC86e4caCCaC5787D7AEC373` (Timelock)
- Method: `schedule(address,uint256,bytes,bytes32,bytes32,uint256)`
- Args: target = `<GUARDIAN>`, value = `0`, data = `<DATA>`,
  predecessor = `0x0`, salt = `<SALT>`, delay = `86400`
- Simulate in Tenderly before signing (per the governance runbook rule).

Verify scheduling landed:

```bash
cast call $TIMELOCK "isOperationPending(bytes32)(bool)" $OP_ID --rpc-url "$OP_MAINNET_RPC"  # true
cast call $TIMELOCK "getTimestamp(bytes32)(uint256)" $OP_ID --rpc-url "$OP_MAINNET_RPC"     # eta (>= now + 86400)
```

The 24h window is the public-announcement period. The watcher fleet and any
observer can see the pending `addSolver` on-chain. If ANYTHING looks wrong,
cancel from the Safe: `TimelockController.cancel(OP_ID)`.

**Safe TX 2, execute** (after the eta):

- To: Timelock
- Method: `execute(address,uint256,bytes,bytes32,bytes32)`
- Args: same target/value/data/predecessor/salt as TX 1.

Verify, then IMMEDIATELY do §6.1:

```bash
cast call 0xAAA13bC6C1A505ccE6B4BF262fdDf4c703B9BD70 "isSolver(address)(bool)" "$LIQ" --rpc-url "$OP_MAINNET_RPC"  # true
```

### 6.1 Watcher SET update (same release as the first sweep, NOT later)

The anomaly watcher treats any non-submitter solver as CRITICAL until it is
told about the liquidator. In the SAME change window as TX 2:

- set `FEE_LIQUIDATOR=<LIQ>` in the environment of
  `settlement-anomaly-watch.sh` (launchd plist) and
  `check-settlement-buffer.sh` (cron), and restart both.

`settlement-anomaly-watch.sh` also REQUIRES `TELEGRAM_BOT_TOKEN_FILE` (a
readable file on THIS host, no personal-home default) and `TELEGRAM_CHAT_ID`
in its launchd env; it refuses to start without a working channel and exits
non-zero if a CRITICAL or the periodic heartbeat fails to deliver, so a dead
pager surfaces as a launchd job failure instead of false silence. Confirm the
first heartbeat lands after enabling.

Skipping the `FEE_LIQUIDATOR` set means every sweep pages CRITICAL, which
trains operators to ignore the pager. That is the failure mode this line
exists to prevent.

## 7. Routine sweeps and (later) consolidation activation

First mainnet sweep, and every sweep until automation is approved:

```bash
# dry-run (eth_call simulation, no key touched):
FEE_LIQUIDATOR=$LIQ ./infra/optimism-mainnet/scripts/sweep-to-safe.sh
# live:
FEE_LIQUIDATOR=$LIQ ./infra/optimism-mainnet/scripts/sweep-to-safe.sh --broadcast
# verify: fee Safe balances up, Settlement buffer near zero,
# check-settlement-buffer.sh shows fresh last_sweep_age_s, watcher stays quiet.
```

Cadence: run when `check-settlement-buffer.sh` shows more than ~$50
aggregate, or monthly before the payout batchers, whichever first. Partner
payouts (partner-fees Phase B) read realized revenue from the `fee_sweeps`
reconciliation table (§9), so a sweep must precede each monthly cycle.

**Consolidation activation AND execution are BOTH owner Safe operations**
(consolidate() is owner-only; the fee-ops hot key cannot call it). When dust
value justifies it (decision-52 "activation later via a Safe transaction"):

1. Activation, owner Safe TX batch:
   - To `LIQ`: `setVenue(0x6131B5fae19EA4f9D964eAc0408E4408b66337b5, true)`
     (KyberSwap MetaAggregationRouterV2, decision 54)
   - To `LIQ`: `setOutputToken(0x4200000000000000000000000000000000000006, true)`
     (WETH, decision 53)
2. Re-verify the KyberSwap Aggregator API surface used by
   `consolidate-fee-dust.sh` (routes + route/build) before the first run;
   the script hard-aborts if the API's router address differs from the
   allowlisted venue.
3. Build the consolidation as a Safe transaction. The runner does NOT sign or
   broadcast: it fetches the route, computes `amountOutMin` at the 100 bps cap
   (it refuses to widen), simulates as the owner Safe, and emits a Safe
   Transaction Builder payload:
   ```bash
   FEE_LIQUIDATOR=$LIQ TOKEN_IN=<dustToken> AMOUNT_IN=<small> \
   OUT_JSON=/tmp/consolidate.json \
     ./infra/optimism-mainnet/scripts/consolidate-fee-dust.sh
   ```
   Import `/tmp/consolidate.json` into the owner Safe, have the 2-of-3 signers
   decode and verify (to == liquidator, the `amountOutMin`, the venue), sign,
   and execute. Aggregator routes go stale in minutes, so re-run the script
   and re-simulate immediately before execution if signing was slow.
4. Every consolidation leaves the WETH in the Settlement; follow with a
   normal sweep (the hot-key path) to move it to the fee Safe.

Deactivation is the mirrored Safe transaction with `false`.

## 8. Rollback and incident response

Fastest first. All are single Safe transactions, none waits 24h:

| Scenario | Action |
|---|---|
| Anything suspicious mid-window | Guardian `removeSolver(LIQ)` (instant; kills sweep + consolidate at the settlement gate) |
| Fee-ops key compromised | Owner `setLiquidator(0)` (pause), then `setLiquidator(newKey)` after re-keying; optionally also removeSolver while investigating |
| Bad venue behavior post-activation | Owner `setVenue(venue, false)`; consolidation is owner-only so only a Safe-signed tx could have routed through it anyway |
| Contract bug suspected | Guardian `removeSolver(LIQ)`, then treat redeploy as a fresh §5+§6 cycle |
| Scheduled timelock op looks wrong | Safe `TimelockController.cancel(OP_ID)` inside the 24h window |

Re-adding solver capability after any rollback ALWAYS re-runs the full §6
ceremony (that is the point of the timelock).

Worst-case bound if the FEE-OPS HOT KEY is compromised while the contract is
a solver: the attacker can only call `sweep`, which moves accrued fees to the
IMMUTABLE fee Safe. That is NOT a loss (funds reach their intended home) and
the attacker cannot redirect them anywhere else. The attacker CANNOT call
`consolidate` (owner-only), so the arbitrary-venue routing path is closed to
a hot key entirely. Venue routing requires the owner Safe (2-of-3); a
compromised Safe is a separate, higher-tier incident bounded by the on-chain
`amountOutMin` floor per consolidation. This is why consolidation is
owner-gated: the hot key never touches an attacker-controllable destination.

## 9. Observability and reconciliation

- `check-settlement-buffer.sh` now reports `liquidator.is_solver`,
  `liquidator.ops_eoa`, `last_sweep_at` / `last_sweep_age_s`, plus the
  optional `ophis_fee_liquidator_last_sweep_age_seconds` pushgateway metric.
- `settlement-anomaly-watch.sh` validates the solver SET and the sweep tx
  shape (to = liquidator contract, from = on-chain `liquidator()`).
- **fee_sweeps reconciliation table (rebate-indexer): planned follow-up,
  documentation reference only in this PR.** The indexer work (nightly
  `Swept`-event ingestion into a `fee_sweeps` table keyed on
  chain/tx/logIndex, a 6h buffer probe, and `GET /fees/ops`) is specced in
  build-plan 4.7 and lands as its own PR against `apps/rebate-indexer`;
  its RUNBOOK.md points back here. Until then, the source of truth for
  realized revenue is the `Swept` event log itself:
  `cast logs --address $LIQ 'Swept(address,uint256)'`.

## 10. Rehearsal + ceremony log

| Date | Step | Chain | Tx / artifact | Operator |
|---|---|---|---|---|
| _pending_ | Sepolia rehearsal §4 | 11155420 | | |
| _pending_ | Mainnet deploy §5 | 10 | | |
| _pending_ | Timelock schedule §6 | 10 | | |
| _pending_ | Timelock execute §6 | 10 | | |
| _pending_ | First sweep §7 | 10 | | |

## Related documents

- **Unichain needs an `addSolver` grant before its sweep can run.** As of
  2026-08-27 the pinned submitter `0x7A956C269a12f1B897367663b536EB5dd29f3fBb`
  returns false from `isSolver` on the chain-130 authenticator
  `0x1002E12f2e7f848b20fe572F92133E467a5D010C`. It settled six times, last on
  2026-07-18, so the allowlist changed after that. The sweep fails **locally**,
  not on-chain: `SweepSettlementBuffer.s.sol` requires `isSolver(broadcaster)`
  before it reaches `vm.startBroadcast`, so nothing is built, signed or
  submitted. There is **no owner-Safe shortcut on chain 130** - its AllowList
  manager is the Guardian and the proxy owner is a 24h TimelockController, so
  `addSolver` goes through that Timelock's schedule / wait / execute flow. Use
  `../../infra/unichain-mainnet/deploy/timelock-governance-runbook.md`, NOT the
  OP-mainnet `allowlist-governance-runbook.md`, whose addresses are OP-specific.
  Optimism and Robinhood are unaffected.
- `sovereign-sweep-rehearsal.md` (what to rehearse BEFORE this ceremony:
  Robinhood needs no ceremony at all, Unichain needs the grant above first, and
  every current buffer sits 30x-100x below the default thresholds, so a stock
  sweep today moves nothing and looks like a clean no-op)
- `../../infra/shared/scripts/sweep-preflight.sh` (read-only precondition check:
  runs each chain's own sweep dry-run and verifies the destination Safe's owners,
  which no runner does)
- `allowlist-governance-runbook.md` (timelock + guardian mechanics, deploy record)
- `fee-recipient-rotation.md` (rotation now REQUIRES a liquidator redeploy;
  see its step list)
- `submitter-pk-backup-runbook.md` (key custody pattern reused for the
  fee-ops key)
- `disaster-recovery-runbook.md` + `contracts/script/SweepSettlementBuffer.s.sol`
  (v1 sweep, DR-only: driver-submitter key + forge script; use when the
  liquidator path is unavailable, e.g. evicted mid-incident with funds still
  accruing)
- `../audits/2026-05-20-cip75-partner-fee-bypass.md` (why fees sit in the
  Settlement at all)
