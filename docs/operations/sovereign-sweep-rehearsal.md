# Sovereign settlement-buffer sweep: rehearsal plan

**Status: PREPARED, NOT EXECUTED.** Every broadcast below is an operator action.
Agents prepare payloads and verify preconditions; humans sign.

Companion to `fee-treasury-ops-runbook.md` (the OP liquidator ceremony). This
document covers what can be rehearsed *now*, on the two chains that need no
ceremony at all, and the order to do it in.

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
| Unichain 130 | `0x108A6787…F714E` | USDC 0.140666, WETH 0.0000581522 | v1 forge script | **none** |
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

## Order: Robinhood, then Unichain, then Optimism

Robinhood first because it is the cheapest rehearsal that proves the most:

- no Timelock on 4663, so no 24h delay and no scheduling ceremony
- largest of the three buffers ($1.20) and the highest take rate (74 bps)
- the v1 path, whose driver-submitter EOA is already allowlisted as a solver
  (Safe vote 2026-05-20), so there is nothing to grant

Unichain is the same path and confirms it generalises. Optimism last, because it
is the only one that needs the `OphisFeeLiquidator` deployed and Timelock-granted,
and there is no reason to spend four owner ceremonies before the mechanism has
been shown to work twice.

## Step 0: preflight (read-only, no keys)

```bash
BROADCASTER=<the driver-submitter EOA> \
  ./infra/shared/scripts/sweep-preflight.sh robinhood
```

Exits 0 only when every precondition PASSED. Exit 2 means at least one check
came back UNKNOWN, which is not a green light: an unverified precondition is
treated the same as a failed one. A mistyped chain name exits 3 rather than
reporting a vacuous "0 passed, 0 failed".

Confirm in particular that the fee Safe has code, that its owners match the
expected 2-of-3 set, and that the right identity is an allowlisted solver -
`settle()` reverts *after* the broadcast otherwise, leaking sweep intent into a
public mempool for nothing. Which identity that is differs by path: on the v1
chains it is the broadcaster EOA (`BROADCASTER`), on the OP v2 path it is the
FeeLiquidator **contract** (`FEE_LIQUIDATOR`), with the ops EOA merely
authorised to call it.

## Step 1: Robinhood dry run, then broadcast

Thresholds are set just under the live balances so the rehearsal actually moves
value. Both `TOKENS` and `MIN_BASE_UNITS` must be supplied together, aligned 1:1
(the forge script rejects `TOKENS` alone, so a 6-decimal token can never inherit
the 1e15 unknown-token default).

```bash
# USDG (6dp, live 1.106040) floor 1 USDG; WETH (18dp, live 0.0000390808) floor 0.00001
export TOKENS=0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168,0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73
export MIN_BASE_UNITS=1000000,10000000000000
export OPHIS_FEE_RECIPIENT_SAFE_ROBINHOOD=0x858f0F5eE954846D47155F5203c04aF1819eCeF8

./infra/robinhood-mainnet/scripts/sweep-to-safe.sh              # dry run first
./infra/robinhood-mainnet/scripts/sweep-to-safe.sh --broadcast  # operator only
```

Note `0x5fc5360d…d168` is the **6-decimal** USDG, the real one. Robinhood Chain
also carries five 18-decimal `USDG` impersonators, each with a round
1,000,000,000 supply, sitting in the same Settlement contract. Sweeping one of
those moves worthless tokens and costs gas. Never resolve USDG by symbol.

## Step 2: Unichain

```bash
# USDC (6dp, live 0.140666) floor 0.1; WETH (18dp, live 0.0000581522) floor 0.00001
export TOKENS=0x078D782b760474a361dDA0AF3839290b0EF57AD6,0x4200000000000000000000000000000000000006
export MIN_BASE_UNITS=100000,10000000000000

./infra/unichain-mainnet/scripts/sweep-to-safe.sh
./infra/unichain-mainnet/scripts/sweep-to-safe.sh --broadcast
```

## Step 3: Optimism (the ceremony)

OP is on the v2 `OphisFeeLiquidator` path and none of it has been executed. The
five pending rows in `fee-treasury-ops-runbook.md` §10 are, in order: Sepolia
rehearsal §4, mainnet deploy §5, Timelock schedule §6, Timelock execute §6
(24h later), first sweep §7.

Do not start this until steps 1 and 2 have both landed. If OP needs sweeping
before then, the v1 forge script remains the documented disaster-recovery
fallback, at the cost of using the driver-submitter key.

Note USDT is **not** in the OP sweep's default token list (USDC, WETH, native
ETH), so the override below deliberately adds it. The OP buffer probe now reports
USDT and native ETH as well, so the hourly watch flags USDT as "not covered by
the chain's sweep configuration" until either the sweep default or the override
picks it up.

For reference, OP's thresholds at current balances would be:

```bash
# USDC 0.354188 floor 0.1 | USDT 0.032961 floor 0.01 | WETH 0.0000440679 floor 0.00001
export TOKENS=0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85,0x94b008aA00579c1307B0EF2c499aD98a8ce58e58,0x4200000000000000000000000000000000000006
export MIN_BASE_UNITS=100000,10000,10000000000000
```

## Verification after each sweep

1. `./infra/shared/scripts/sweep-preflight.sh <chain>` — buffer line should now
   read near zero.
2. Fee Safe balance on that chain should be up by the swept amount.
3. The hourly `settlement-buffer-watch` job should go quiet on that chain. If it
   keeps alerting, the sweep did not land, whatever the transaction receipt said.

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
