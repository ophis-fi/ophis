# CIP-75 partner-fee: accumulates in Settlement, doesn't reach Safe

**Date:** 2026-05-20 (discovered during Phase 3.1 first-real-swap)
**Severity:** MEDIUM (architectural; not material until volume scales)
**Status:** Confirmed, mitigation TBD
**Filed by:** Phase 3.1 E2E verification

## Update 2026-05-20 — original "OKX bypass" framing was wrong

Settlement contract `0x310784c7…` has a balance of 794 USDC base units —
the fees ARE accumulating there. The `0xfa00a9ed…` transfer in the
settlement tx is **OKX's OWN aggregator margin** (their commission paid
out of the swap proceeds), not our CIP-75 fee. The original finding
mis-attributed the on-chain transfer.

What's actually happening:

1. CIP-75 calculates a `priceImprovement` fee (e.g. 311 USDC base units)
   correctly per the order's app-data.
2. The fee is collected by REDUCING the user's buyAmount: user receives
   `executedBuy - fee` (here, 2,119,924 against a quoted 2,120,260).
3. The fee REMAINS IN THE SETTLEMENT CONTRACT — there's no on-chain
   transfer to the Safe.
4. CoW Settlement has no admin "withdraw" function — accumulated
   tokens can only leave via the `settle()` calldata's interactions.

Net effect: fees are silently accumulating in Settlement. The Safe
balance stays at 0. Material loss is bounded by volume but the design
is broken — there's no path from "fee collected" to "Safe enriched"
without additional code.

## Summary

CIP-75 partner-fee accumulates in the Settlement contract on Ophis OP
mainnet. The configured recipient Safe
(`0x858f0F5eE954846D47155F5203c04aF1819eCeF8`) never receives the
fees. The orderbook records the *intended* fee, not the *realized
transfer*, so any dashboard sourced from `executedProtocolFees.amount`
overstates realized Safe revenue by 100%.

## Evidence

Reference tx: `0x4148d94f3091beff8c1c0e992076e1104a65581ed1c0cb736e198173d0850308`
(block `0x90cea1b`, OP mainnet, 2026-05-20).

### What the orderbook says

`/api/v1/trades?orderUid=0x0933ca0c...4d6` returns:

```json
{
  "executedProtocolFees": [{
    "policy": { "priceImprovement": {
      "factor": 0.25,
      "maxVolumeFactor": 0.005,
      "quote": { ... }
    }},
    "amount": "311",
    "token": "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85"
  }]
}
```

So the orderbook believes 311 USDC base units of partner-fee were collected.

### What the chain says

`eth_getTransactionReceipt` on the settlement tx yields these Transfer
events (filtered to ERC20 events involving USDC `0x0b2C…85`):

| from | to | value | meaning |
|---|---|---|---|
| `0x478946bcd4…ba25` | `0xdd5e9b947c…83e7` | 2,120,649 | OKX aggregator → intermediary |
| `0xdd5e9b…83e7` | `0xfa00a9ed78…2a1b` | **415** | **the "partner fee" — wrong recipient** |
| `0xdd5e9b…83e7` | `0x310784c7fc…b859` | 2,119,210 | intermediary → CoW Settlement |
| `0x310784c7…b859` | `0x5795be97…2570` | 2,119,924 | Settlement → user (buyAmount) |

`eth_call balanceOf(safe)` on `0x858f0F5eE954846D47155F5203c04aF1819eCeF8`:

```
0x0000000000000000000000000000000000000000000000000000000000000000
```

(zero — the Safe received nothing.)

`eth_getLogs Transfer` filtered by `topics[2] = 0x...858f0F5e…CeF8` over
the last 1000 blocks: empty array. No historical transfers to the Safe
either.

### What 0xfa00a9ed... is

- `eth_getCode` returns `0x` → EOA, not a contract
- Not referenced anywhere in the Ophis codebase (`grep -r 0xfa00a9ed`
  returns zero matches)
- Externally controlled by OKX

## Root cause hypothesis

The OKX solver wraps OnchainOS aggregator. OnchainOS has its own
fee-taking mechanism that's hardcoded to its operator-controlled EOA. The
CoW Settlement calldata that the driver assembles passes the swap through
OnchainOS's router, which deducts its fee BEFORE the swap proceeds reach
the CoW Settlement contract. The CIP-75 partner-fee mechanism — which
operates AFTER Settlement receives the buy-token — has nothing to deduct
because the fee already went elsewhere.

The orderbook records what *should* have been collected per the order's
CIP-75 policy, not what *was* actually transferred. That's why the
accounting and chain state diverge.

## Investigation steps

1. **Confirm reproduction**: place a swap that's likely to be won by
   KyberSwap or Velora (different route shape; smaller pool surface).
   Verify on-chain Transfer events route the partner-fee to the Safe.
   Confirms whether this is OKX-specific or all-solver.

2. **Read OKX solver source**: `apps/solvers/okx/` (or wherever Ophis
   forked the OnchainOS adapter). Check whether the solver
   actually passes `appData.partnerFee.recipient` into the OKX swap
   construction, OR if it builds the swap with a hardcoded fee config.

3. **Read CIP-75 hook**: `apps/contracts/src/cip75/`. Confirm the
   partner-fee hook is a POST-Settlement hook (not embedded in the swap
   path itself). If it's POST, then the OKX-collected fee is "extra" on
   top of CIP-75, and the bug is just that OnchainOS takes a slice we
   didn't ask for. If it's a PRE-hook, the OKX swap is consuming the
   fee budget before CIP-75 sees it.

4. **Decide mitigation**:
   - **Option A (cleanest):** Patch the OKX solver to set its
     `referrer.feeReceiver` parameter to our Safe address. Requires the
     OKX OnchainOS API to support arbitrary fee receivers (unverified).
   - **Option B (operationally safe):** Wrap the OKX swap path with a
     post-Settlement transfer that sends the realized USDC delta (above
     `quote.buyAmount`) to the Safe. Adds gas but is solver-agnostic.
   - **Option C (revenue-quickest):** Drop OKX from the auction
     temporarily and rely on KyberSwap + Velora (assuming they DO route
     CIP-75 correctly).
   - **Option D (operationally simplest):** Accept the loss for now and
     re-investigate when OKX support responds.

## Related

- Phase 3.1 first-swap finding (this doc is the formal write-up)
- Existing docs:
  - `docs/audits/2026-05-18-phase2-backend.md` §C1 (partner-fee social-
    binding finding — different but related)
  - `docs/development/phase-2-5-validation.md` §D3 (Safe deployment +
    threshold guidance)

## Bookkeeping fix (independent)

Independent of the on-chain fix, `executedProtocolFees.amount` in the
orderbook should be **reconciled against actual on-chain Transfer events
to the Safe**. Currently it reports the intended fee, not the realized
one. Suggested:

- Add a post-Settlement cross-check that compares `executedProtocolFees`
  against `Transfer(Settlement → Safe)` events in the same tx
- Surface a `feeRealized` field that defaults to zero when the on-chain
  Transfer is absent
- Alert (PagerDuty/Telegram) when `feeRealized / feeIntended < 0.5` over
  any 10-settlement window
