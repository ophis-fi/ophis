# Fee-treasury ops runbook (OphisFeeLiquidator)

**Status: CODE ONLY. Nothing in this runbook has been executed on-chain.**
Every step below that deploys, schedules, signs, or broadcasts is an OWNER
ceremony: it is performed by the operator (protocol-Safe signers + the infra
host owner), never by an agent. Agents prepare payloads; humans sign.

Scope: the fee-ops Wave 2 deliverable (build-plan section 4.7, decisions
52-57 with the recommended defaults). One constrained ops surface, distinct
from the protocol Safe and the driver-submitter key, that can only:

1. **sweep** accrued CIP-75 fees from the OP Settlement contract to the fee
   Safe (`OphisFeeLiquidator.sweep`, amount 0 = full balance, address(0) =
   native ETH), and
2. **consolidate** multi-denomination fee dust in place into WETH with a
   mandatory `amountOutMin` floor (`OphisFeeLiquidator.consolidate`),
   DISABLED at launch: the venue allowlist deploys empty (decision 52) and
   activation is a later Safe transaction, no redeploy.

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
- The **ops key** only reaches the two `onlyOps` functions. It cannot change
  the destination (immutable), the venue set, or its own successor.
- The **owner Safe** can pause the key (`setLiquidator(0)`), rotate it, and
  allowlist venues/output tokens, all instant, all capability-narrowing or
  reversible. Adding solver capability is the ONLY 24h-delayed action.

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
  attacker holding ONLY this key can do is sweep fees to the fee Safe
  (destination pinned) or, post-activation, consolidate dust into WETH
  inside the Settlement with at most the configured slippage. Rotation is
  one Safe transaction.

## 3. What ships in the repo (already merged when you read this)

- `contracts/src/contracts/OphisFeeLiquidator.sol` (contract; MIT notice)
- `contracts/script/DeployFeeLiquidator.s.sol` (deploy script)
- `contracts/test/OphisFeeLiquidator/` (forge suite incl. fuzz)
- `contracts/echidna/E2EFeeLiquidator.sol` (weekly fuzz lane, echidna.yml)
- `infra/optimism-mainnet/scripts/sweep-to-safe.sh` (v2 runner, cast-send)
- `infra/optimism-mainnet/scripts/consolidate-fee-dust.sh` (prepared, inert
  until venue activation)
- `infra/optimism-mainnet/scripts/settlement-anomaly-watch.sh` (solver-SET
  aware; `FEE_LIQUIDATOR` env)
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

# 4.2 deploy
cd contracts
SETTLEMENT=0x0864b65F1EFe752a699d119Ae0419E7331a8Bfce \
FEE_SAFE=$REHEARSAL_SAFE OWNER=$REHEARSAL_EOA LIQUIDATOR=$REHEARSAL_OPS \
PRIVATE_KEY=<deployer pk> \
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

# 4.6 pause/unpause: setLiquidator(0) from OWNER; confirm the ops key gets
#     "OFL: caller not ops"; setLiquidator back.

# 4.7 consolidation dry ceremony: deploy the forge-test MockVenueRouter,
#     setVenue + setOutputToken from OWNER, run one consolidate with a
#     hand-built calldata and amountOutMin, then setVenue(false).
forge create test/OphisFeeLiquidator/Mocks.sol:MockVenueRouter --rpc-url "$RPC" --private-key <pk>

# 4.8 rollback rehearsal: removeSolver from the manager; confirm sweep now
#     reverts "GPv2: not a solver".
```

Exit criteria: every step above behaved as documented, including BOTH abort
paths (pin-check abort, paused abort). Record tx hashes in this file's
rehearsal log (§10).

## 5. Mainnet deployment (owner ceremony)

Deployment itself grants no authority (the contract only matters once the
timelock adds it as a solver), so the deployer is any gas-funded EOA.

```bash
cd contracts
# dry-run first (no PRIVATE_KEY, --sender only):
LIQUIDATOR=<fee-ops EOA> forge script DeployFeeLiquidator \
  --rpc-url "$OP_MAINNET_RPC" --sender <deployer>
# live:
LIQUIDATOR=<fee-ops EOA> PRIVATE_KEY=<deployer pk> forge script DeployFeeLiquidator \
  --rpc-url "$OP_MAINNET_RPC" --broadcast
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

Skipping this means every sweep pages CRITICAL, which trains operators to
ignore the pager. That is the failure mode this line exists to prevent.

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

**Consolidation activation** (later, when dust value justifies it; this is
the decision-52 "activation later via a Safe transaction"):

1. Owner Safe TX batch:
   - To `LIQ`: `setVenue(0x6131B5fae19EA4f9D964eAc0408E4408b66337b5, true)`
     (KyberSwap MetaAggregationRouterV2, decision 54)
   - To `LIQ`: `setOutputToken(0x4200000000000000000000000000000000000006, true)`
     (WETH, decision 53)
2. Re-verify the KyberSwap Aggregator API surface used by
   `consolidate-fee-dust.sh` (routes + route/build) before the first run;
   the script hard-aborts if the API's router address differs from the
   allowlisted venue.
3. First run: dry-run, then broadcast with a SMALL `AMOUNT_IN`, runner
   slippage cap 100 bps (the script refuses more).
4. Every consolidation leaves the WETH in the Settlement; follow with a
   normal sweep.

Deactivation is the mirrored Safe transaction with `false`.

## 8. Rollback and incident response

Fastest first. All are single Safe transactions, none waits 24h:

| Scenario | Action |
|---|---|
| Anything suspicious mid-window | Guardian `removeSolver(LIQ)` (instant; kills sweep + consolidate at the settlement gate) |
| Fee-ops key compromised | Owner `setLiquidator(0)` (pause), then `setLiquidator(newKey)` after re-keying; optionally also removeSolver while investigating |
| Bad venue behavior post-activation | Owner `setVenue(venue, false)`; slippage floor already bounds per-tx damage to 100 bps of the consolidated dust |
| Contract bug suspected | Guardian `removeSolver(LIQ)`, then treat redeploy as a fresh §5+§6 cycle |
| Scheduled timelock op looks wrong | Safe `TimelockController.cancel(OP_ID)` inside the 24h window |

Re-adding solver capability after any rollback ALWAYS re-runs the full §6
ceremony (that is the point of the timelock).

Worst-case bound while the contract is a solver: an attacker with the ops
key can move accrued fees to the fee Safe (no loss) or, post-activation,
consolidate dust into WETH within the slippage cap (bounded loss =
`SLIPPAGE_BPS` of the dust consolidated per tx). The attacker cannot
redirect funds anywhere else; both flows end inside Ophis-controlled
addresses.

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
