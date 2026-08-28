# Sovereign settlement-buffer sweep: rehearsal plan

**Status: PREPARED, NOT EXECUTED.** Every broadcast below is an operator action.
Agents prepare payloads and verify preconditions; humans sign.

Companion to `fee-treasury-ops-runbook.md` (the OP liquidator ceremony). This
document covers what can be rehearsed *now* and in what order. Only **Robinhood**
needs no ceremony; Unichain is blocked on an `addSolver` grant through its 24h
Timelock (see below), and Optimism needs the liquidator deployed and granted.

## Why now, when the amount is trivial

The three sovereign Settlement contracts hold **$1.99** between them. Recovering
that is not the point and would not justify a signature.

The point is that the sweep has **never been executed on any chain**, and the
sovereign model is the high-margin half of the business: it realizes **44 to 74
bps** against **1 to 9 bps** on the CoW-hosted chains. Per
`contracts/script/SweepSettlementBuffer.s.sol`, an unswept buffer is recycled
into future traders' price improvement, which is functionally zero Ophis
revenue. So the whole margin advantage of running our own stack currently
converts to nothing, and the mechanism that would convert it is unproven.

Rehearse it while it is worth $2. The alternative is debugging it live, for the
first time, against real money, on the day Robinhood volume steps up.

## Current state (verified on-chain 2026-08-27)

| Chain | Settlement | Buffer | Sweep path | Ceremony needed |
|---|---|---|---|---|
| Robinhood 4663 | `0x886d9fd3…57cD` | USDG 1.106040, WETH 0.0000390808 | v1 forge script | **none** |
| Unichain 130 | `0x108A6787…F714E` | USDC 0.140666, WETH 0.0000581522 | v1 forge script | **solver grant** (see below) |
| Optimism 10 | `0x310784c7…B859` | USDC 0.354188, USDT 0.032961, WETH 0.0000440679 | v2 liquidator | deploy + 24h Timelock |

Two corrections to what was previously recorded:

- **The Robinhood blocker is gone.** The recorded reason the 4663 sweep was
  blocked was that the fee Safe had no code there. It does now: VERSION 1.4.1,
  threshold 2, the expected three owners. `sweep-to-safe.sh` still requires the
  destination to be pinned explicitly, and that requirement stays.
- **Every current balance is below every default threshold**, by 30x to 100x. A
  sweep run today with stock settings sweeps *nothing*, on all three chains, and
  would look like a successful no-op. The overrides below are what make the
  rehearsal actually move value.

## ⚠️ Unichain is blocked today

The preflight found it: on chain 130 the pinned submitter
`0x7A956C269a12f1B897367663b536EB5dd29f3fBb` is **not currently an allowlisted
solver**. `isSolver` on the authenticator `0x1002E12f2e7f848b20fe572F92133E467a5D010C`
returns false (verified 2026-08-27 with a successful call, not an RPC error), so a
Unichain sweep cannot run. It fails **locally**, not on-chain:
`SweepSettlementBuffer.s.sol` requires `auth.isSolver(broadcaster)` before it
reaches `vm.startBroadcast`, so nothing is built, signed or submitted. Treat it
as an ordinary precondition failure, not a leaked transaction or an incident.

That EOA did settle successfully six times, most recently **2026-07-18**, so the
allowlist changed at some point after that. The cause was not established here:
a full allowlist event scan needs an archive endpoint the free RPC tier refuses.

Consequence for this plan: Unichain needs an `addSolver` grant before its sweep
can run, and there is **no owner-Safe shortcut on chain 130**. Its AllowList
manager is the Guardian and the proxy owner is a 24h TimelockController, so
`addSolver` is callable only through that Timelock's schedule / wait / execute
flow. Follow `../../infra/unichain-mainnet/deploy/timelock-governance-runbook.md`,
not the OP-mainnet `allowlist-governance-runbook.md`, whose addresses are
OP-specific. Robinhood is unaffected and its submitter checks out.

## Order: Robinhood, then Unichain, then Optimism

Robinhood first because it is the cheapest rehearsal that proves the most:

- no Timelock on 4663, so no 24h delay and no scheduling ceremony
- largest of the three buffers ($1.20) and the highest take rate (74 bps)
- the v1 path, whose driver-submitter EOA is already allowlisted as a solver
  (Safe vote 2026-05-20), so there is nothing to grant

Unichain is the same path and would confirm it generalises, but see the blocker
above: it needs a solver grant first, so in practice it may land after Optimism.
Optimism last of the original three, because it
is the only one that needs the `OphisFeeLiquidator` deployed and Timelock-granted,
and there is no reason to spend four owner ceremonies before the mechanism has
been shown to work twice.

## Step 0: preflight (read-only, no keys)

Every command below sets its environment **command-locally**. Nothing is
exported: run these steps in one shell with `export` and each chain's RPC and
token overrides bleed into the next, which then preflights the wrong chain's
configuration against the wrong endpoint.

```bash
# The preflight runs the chain's OWN sweep-to-safe.sh in dry-run, so give it the
# exact environment the sweep will be run with. It never loads a key.
# Define the environment ONCE and use the same array for the preflight and the
# sweep. Preflighting a different environment than the one you then broadcast
# with checks a configuration nobody runs - and because every live balance is
# below the stock thresholds, a preflight without the overrides gets a clean
# no-op from the runner instead of simulating the sweep you actually intend.
RBH_ENV=(OPHIS_RPC=<the Robinhood RPC the sweep will use>
         OPHIS_FEE_RECIPIENT_SAFE_ROBINHOOD=0x858f0F5eE954846D47155F5203c04aF1819eCeF8
         ROBINHOOD_SUBMITTER_ADDR=0x95f0beaB29BeA3D18A7c81140AED9227Ff2D7665
         OPHIS_SETTLEMENT_ROBINHOOD=0x886d9fd312F442C4E1f3cdeAE7b4AB73493e57cD
         TOKENS=0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168,0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73
         MIN_BASE_UNITS=1000000,10000000000000)

env "${RBH_ENV[@]}" ./infra/shared/scripts/sweep-preflight.sh robinhood
```

Exit 0 only when everything PASSED; exit 2 means something came back UNKNOWN,
which is not a green light either, and a mistyped chain name exits 3.

It reports two things. First, whether the runner's own dry-run accepted its
configuration — that covers the RPC and its chain id, the submitter, the
Settlement, the destination and its on-chain code, and the thresholds, in the
runner's own words. It does **not** cover the runners' submitter-nonce guards:
those sit inside their `--broadcast` branch, so a dry-run never reaches them and
a broadcast can still abort there. Second, the one check no runner performs:
the destination Safe's **owners and threshold**. Every runner verifies the
destination has code; none verifies who controls it, and a rotated Safe still
has code.

## Step 1: Robinhood dry run, then broadcast

Thresholds are set just under the live balances so the rehearsal actually moves
value. Both `TOKENS` and `MIN_BASE_UNITS` must be supplied together, aligned 1:1
(the forge script rejects `TOKENS` alone, so a 6-decimal token can never inherit
the 1e15 unknown-token default).

```bash
# USDG (6dp, live 1.106040) floor 1 USDG; WETH (18dp, live 0.0000390808) floor 0.00001
env "${RBH_ENV[@]}" ./infra/robinhood-mainnet/scripts/sweep-to-safe.sh              # dry run first
env "${RBH_ENV[@]}" ./infra/robinhood-mainnet/scripts/sweep-to-safe.sh --broadcast  # operator only
```

Note `0x5fc5360d…d168` is the **6-decimal** USDG, the real one. Robinhood Chain
also carries five 18-decimal `USDG` impersonators, each with a round
1,000,000,000 supply, sitting in the same Settlement contract. Sweeping one of
those moves worthless tokens and costs gas. Never resolve USDG by symbol.

## Step 2: Unichain

Preflight this chain first — the checks are per chain and step 0 only covered
Robinhood:

```bash
# Unichain reads a bare SAFE and OPHIS_SUBMITTER_EOA; set them before preflighting.
UNI_ENV=(OPHIS_RPC=<the Unichain RPC the sweep will use>
         SAFE=0x858f0F5eE954846D47155F5203c04aF1819eCeF8
         OPHIS_SUBMITTER_EOA=0x7A956C269a12f1B897367663b536EB5dd29f3fBb
         TOKENS=0x078D782b760474a361dDA0AF3839290b0EF57AD6,0x4200000000000000000000000000000000000006
         MIN_BASE_UNITS=100000,10000000000000)

env "${UNI_ENV[@]}" ./infra/shared/scripts/sweep-preflight.sh unichain
```

```bash
# USDC (6dp, live 0.140666) floor 0.1; WETH (18dp, live 0.0000581522) floor 0.00001
env "${UNI_ENV[@]}" ./infra/unichain-mainnet/scripts/sweep-to-safe.sh
env "${UNI_ENV[@]}" ./infra/unichain-mainnet/scripts/sweep-to-safe.sh --broadcast
```

## Step 3: Optimism (the ceremony)

OP is on the v2 `OphisFeeLiquidator` path and none of it has been executed. The
five pending rows in `fee-treasury-ops-runbook.md` §10 are, in order: Sepolia
rehearsal §4, mainnet deploy §5, Timelock schedule §6, Timelock execute §6
(24h later), first sweep §7.

Gate this on the **Robinhood** rehearsal only. Unichain is blocked on a solver
grant that has nothing to do with the Optimism deployment, and waiting for it
would stall Optimism indefinitely for no reason. If OP needs sweeping before the
liquidator ceremony, the v1 forge script remains the documented
disaster-recovery fallback, at the cost of using the driver-submitter key.

Note USDT is **not** in the OP sweep's default token list (USDC, WETH, native
ETH), so the override below deliberately adds it. Whether any hourly monitor
reports that USDT balance depends on that monitor's own probe coverage, which is
outside this document.

Preflight Optimism **after** the deploy and the Timelock execute, immediately
before the first sweep. Run earlier it cannot pass: before deployment the
liquidator's getters are unreadable, and before the Timelock executes its solver
check necessarily fails.

```bash
# The trailing 0x000...0 is the runner's NATIVE marker: it only sweeps the
# Settlement's native ETH when that marker is in TOKENS. Overriding TOKENS
# replaces the whole default list, so dropping it would silently leave every ETH
# refund behind while moving the three ERC20s.
OP_ENV=(FEE_LIQUIDATOR=$LIQ
        BROADCASTER=0x<fee-ops EOA ADDRESS, never the key>
        OPHIS_RPC=<the Optimism RPC>
        TOKENS=0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85,0x94b008aA00579c1307B0EF2c499aD98a8ce58e58,0x4200000000000000000000000000000000000006,0x0000000000000000000000000000000000000000
        MIN_BASE_UNITS=100000,10000,10000000000000,3000000000000000)

env "${OP_ENV[@]}" ./infra/shared/scripts/sweep-preflight.sh optimism
```

`BROADCASTER` is the **public address** of the fee-ops EOA, never its private
key: it is only compared against what `liquidator()` returns. The preflight
refuses anything that is not a 20-byte address and withholds the value from its
own output, so a mis-paste cannot reach the ceremony log. Without it the ops-key
check reports UNKNOWN and the preflight exits 2.

For reference, OP's thresholds at current balances would be:

These must be attached to the runner invocation, not left as bare assignments:
the runbook's routine command passes only `FEE_LIQUIDATOR`, and with the stock
defaults every current OP balance is below threshold, so the "first sweep" would
exit successfully having moved nothing and silently skipped USDT.

```bash
# USDC 0.354188 floor 0.1 | USDT 0.032961 floor 0.01 | WETH 0.0000440679 floor 0.00001


env "${OP_ENV[@]}" ./infra/optimism-mainnet/scripts/sweep-to-safe.sh              # dry run
env "${OP_ENV[@]}" ./infra/optimism-mainnet/scripts/sweep-to-safe.sh --broadcast  # operator only
```

## Verification after each sweep

Record the buffer and the fee Safe balance **before** broadcasting, then:

1. Re-run the chain's sweep dry-run — it prints the per-token balances it would
   move, which should now be below threshold. Use the same environment as the
   pre-sweep run; command-local assignments do not survive into this step.
2. The fee Safe balance on that chain should be **up by that same amount**. This
   is the check that actually proves the sweep worked, so do it explicitly rather
   than inferring it.
3. Check the receipt for the right event. On **Robinhood and Unichain** the v1
   forge script calls `GPv2Settlement.settle()` directly and emits no `Swept` —
   look for the ERC20 `Transfer` events out of the Settlement to the fee Safe.
   `Swept` belongs to `OphisFeeLiquidator`, so it only appears on the Optimism
   v2 path.

Do **not** use an hourly buffer monitor as the verification for these
rehearsals, if one is running. Every balance here is below the stock sweep
thresholds on purpose — only the manual overrides lower them — so such a monitor
is already quiet before the sweep and stays quiet whether it moved everything,
moved nothing, or reverted. It would corroborate a failed rehearsal. A monitor
is only a valid post-check for a condition it was actively alerting on
beforehand.

## What this does not fix

Sweeping moves fees from Settlement into the fee Safe. It does **not** make them
reachable by the rebate pipeline: the pool reads WETH on Gnosis, and rebate
accounting is Gnosis-denominated. Sovereign-chain revenue accumulating in the
Safe on OP, Unichain and Robinhood is a separate, unsolved routing question, and
worth deciding deliberately rather than discovering later.

## Standing decision to revisit

The runbook's routine cadence is "sweep when the buffer exceeds ~$50 aggregate,
or monthly before the payout batchers". At current volumes that threshold is
about 25x away, so after this rehearsal the correct steady state is: leave the
buffers alone, let the hourly watch tell you when they are worth a signature,
and do not spend ceremonies on dust.
