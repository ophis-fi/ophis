---
id: migrating-from-odos
title: Migrating from Odos
description: Keep your Odos v3 request shape and point it at compat.ophis.fi. You get the QuoteResponse fields you already parse plus an unsigned Ophis order draft. One signature replaces the swap transaction, and settlement is asynchronous via batch auctions.
sidebar_label: Migrating from Odos
sidebar_position: 9
---

# Migrating from Odos

Ophis runs a compatibility surface for integrators who built against the Odos
v3 API. It accepts the request shape you already send (PathRequestV3 field
names, single token in and single token out) and answers with the
QuoteResponse field surface you already parse, plus a namespaced `ophis` block
that carries what an intent settlement actually needs: an unsigned order
draft, the EIP-712 signing envelope, and a submit path.

"Odos" is used on this page in its plain factual sense, to describe the wire
shape this surface accepts. Ophis is an independent protocol.

## TL;DR

1. Change your base URL to `https://compat.ophis.fi`.
2. Keep your quote payload. `POST /sor/quote/v3` works with the field names
   you already send.
3. Stop sending a transaction. There is no `transaction` object to broadcast.
   Instead, sign `ophis.order` (EIP-712) and `POST /sor/submit`.
4. Poll `GET /sor/order-status/{chainId}/{orderUid}`. Settlement is
   asynchronous: solvers compete for your order in the next batch auction.

## What is the same

| Piece | Status |
|---|---|
| `POST /sor/quote/v3` request field names | Accepted as-is (single input, single output) |
| `POST /sor/assemble` with `userAddr` + `pathId` | Accepted; `pathId` is valid for up to 60 seconds |
| `POST /sor/swap/v3` (quote + assembly in one call) | Accepted; requires `userAddr` |
| QuoteResponse fields (`inAmounts`, `outAmounts`, `netOutValue`, `pathId`, ...) | Returned field for field |
| `referralCode` attribution | Works today; the integer code becomes the Ophis referral code `odos<code>` |
| Slippage (`slippageLimitPercent`) | Becomes the signed limit, in bips, hard cap 50% |

## What changes, stated plainly

Ophis is an intent protocol settled by competitive batch auctions, not a
router that returns calldata. Three consequences are structural and this
surface does not paper over them:

1. **No `transaction` object, ever.** `/sor/assemble` and `/sor/swap/v3`
   return `transaction: null`. The signable artifact is `ophis.order`, an
   EIP-712 CoW-style order. If your integration composes swap calldata inside
   your own contract call (atomic same-transaction execution), this surface
   does not cover that today. That is a real gap, not a configuration issue.
   Output hooks and a firm-quote lane are under evaluation; until they ship,
   this page will not claim them.
2. **Settlement is asynchronous.** You submit a signed order, a solver wins
   it in a batch auction, and the settlement lands one or more blocks later.
   Typical latency is a few batches; the order simply expires at
   `order.validTo` (default 20 minutes) if it cannot be filled at your limit.
   You get MEV protection and surplus in exchange: orders settle at the
   clearing price, and anything better than your signed minimum is yours.
3. **You pay no gas.** `gasEstimate`, `gweiPerGas` and `gasEstimateValue` are
   0 because you broadcast nothing. The winning solver pays settlement gas and
   that cost is already priced into the quoted amounts. The embedded estimate
   is visible in `ophis.executionCost`.

One smaller deviation:

- **Values are native-denominated, not USD.** `inValues`, `outValues` and
  `netOutValue` are denominated in the chain's native token and
  `ophis.valueCurrency: "native"` says so. `percentDiff` is pinned to 0 and
  `priceImpact` to null rather than fabricated from a feed Ophis does not
  have. USD values return when a price feed is wired; the response shape will
  not change.

## Settlement timing

Because settlement is asynchronous, the quote response carries
`ophis.expectedSettlementSeconds`: a typical quote-to-settlement latency in
whole seconds. It is derived from the Optimism batch cadence (the auction
grants solvers a bounded solve window, then the winning settlement confirms a
few blocks later) and is a **typical estimate, not a guarantee**. An order can
wait for more than one auction, and it simply expires at `order.validTo` if it
cannot be filled at your limit. Treat the number as a planning hint, not an SLA.

Instead of busy-polling order status, you can block on a bounded long-poll:

```
GET /sor/settlement/{chainId}/{orderUid}?waitSeconds=20
```

It holds the request open until the order reaches a terminal state (settled,
expired, or cancelled) or the bounded wait elapses, then returns
`{ settled, terminal, pending, status, txHash, executedSellAmount,
executedBuyAmount, order, trades }`. `waitSeconds` is clamped (default 20,
maximum 55); if it returns `pending: true`, reconnect after
`ophis.pollAgainAfterSeconds`. It is a long-poll, not a callback webhook: a
stateless edge worker cannot hold a background callback past the request, so
the wait is always bounded and there are no hidden retries.

## Partner fees

If the partner-fee program is enabled on this deployment, a non-zero
`referralFee` maps to a CIP-75 Volume fee to `referralFeeRecipient`, embedded in
the order's appData beside the Ophis protocol fee. The Odos decimal fraction
converts to basis points: `0.001` becomes a 10 bps Volume fee. Fees are
bps-granular, so the value is rounded to the nearest basis point. The mapped
entry is floored on its own bps, and the compat surface has no on-chain token
registry to establish stable or boosted eligibility, so it enforces the
conservative per-pair minimum of **4 bps**: a fee smaller than 4 bps
(`0.0004`) is rejected rather than mapped to a draft the orderbook would reject
at submit. The reduced 1 bps floor applies only to stable and boosted pairs,
which the compat surface cannot establish.

The recipient must be a **registered, active partner-fee recipient**. Register
once with `POST /api/v1/partners`; see [Partner integration](./partners.md). A
mapped fee above the program-wide 90 bps third-party cap is rejected with
`PARTNER_FEE_CAP_EXCEEDED` rather than silently reduced, so you never charge
less than you asked. A recipient's own registered cap (50 bps by default) is
lower still and is enforced by the orderbook at submit.

While the program is disabled on this deployment, a non-zero `referralFee`
returns `PARTNER_FEE_UNAVAILABLE` instead of being silently dropped, so no
partner discovers missing revenue weeks later. `referralCode` attribution works
in either state.

## The three-step flow

### 1. Quote

```bash
curl -sS -X POST https://compat.ophis.fi/sor/quote/v3 \
  -H 'content-type: application/json' \
  -d '{
    "chainId": 10,
    "inputTokens":  [{ "tokenAddress": "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", "amount": "1000000000" }],
    "outputTokens": [{ "tokenAddress": "0x4200000000000000000000000000000000000006", "proportion": 1 }],
    "userAddr": "0xYourAccount",
    "slippageLimitPercent": 0.3
  }'
```

The response carries the familiar surface plus the `ophis` block:

```jsonc
{
  "inAmounts": ["1000000000"],
  "outAmounts": ["538126832449298940"],
  "netOutValue": 0.538126,          // native-denominated (ETH on Optimism)
  "pathId": "eyJ2IjoxL...",         // valid up to 60 s
  "partnerFeePercent": 0.05,        // 5 bps, already priced into outAmounts
  "gasEstimate": 0,                  // you broadcast nothing
  "ophis": {
    "settlementModel": "batch-auction-async",
    "valueCurrency": "native",
    "assemblable": true,
    "order": { "sellToken": "0x0b2C...", "buyAmount": "536512451951951043", ... },
    "signing": { "domain": { ... }, "types": { ... }, "primaryType": "Order" },
    "fullAppData": "{...}",
    "submit": { "url": "/sor/submit", "method": "POST" },
    "warnings": [ ... ]
  }
}
```

Send `userAddr` if you want to sign: without it the response is quote-only
(`assemblable: false`, `pathId: null`).

### 2. Sign

`/sor/assemble` rebuilds the unsigned draft from the `pathId` (same contract
as before: `userAddr` + `pathId`, optional `receiver` override). You can also
skip assemble entirely: the quote response already contains the draft. Sign it
as EIP-712 typed data:

```ts
import { createWalletClient, http } from 'viem';

const { order, signing } = quote.ophis;
const signature = await wallet.signTypedData({
  domain: signing.domain,
  types: signing.types,
  primaryType: signing.primaryType,
  message: order,
});
```

The signing domain pins the Ophis settlement contract for the chain
(`0x310784c7FCE12d578dA6f53460777bAc9718B859` on Optimism). Before the first
sell of a token, approve the Ophis vault relayer
(`0x83847EaB41ad9ea43809ce71569eB2e9daF51830` on Optimism) for the sell
amount, in place of the router approval you had.

A note on `receiver`: proceeds are pinned to the signing account by default.
If you override `receiver` to a different address, the response flags it and
`/sor/submit` refuses the order unless you also send
`acceptNonOwnerReceiver: true`. That friction is deliberate.

### 3. Submit and poll

```bash
curl -sS -X POST https://compat.ophis.fi/sor/submit \
  -H 'content-type: application/json' \
  -d '{
    "chainId": 10,
    "order": { ...signed order fields... },
    "signature": "0x...",
    "signingScheme": "eip712",
    "from": "0xYourAccount",
    "fullAppData": "...the exact string from the quote...",
    "quoteId": 9858
  }'
```

The relay re-validates everything (appData hash, receiver pinning, amount
bounds) and forwards the order to the Ophis orderbook. It holds no keys and
never signs. Then poll:

```
GET /sor/order-status/10/{orderUid}
```

until `status` is `fulfilled` (with `txHash` and executed amounts from the
settlement trades), `expired`, or `cancelled`. To avoid a tight poll loop, block
on the bounded long-poll instead: `GET /sor/settlement/10/{orderUid}` returns as
soon as the order settles or the wait elapses (see Settlement timing above).

## Request field mapping

| v3 request field | What Ophis does with it |
|---|---|
| `chainId` | Must be an enabled Ophis-operated chain (10, 130 today) |
| `inputTokens` | Exactly one entry: sell token + amount (exact-in). More than one: `MULTI_TOKEN_UNSUPPORTED` until basket intents ship |
| `outputTokens` | Exactly one entry, `proportion` 1. Splits return with baskets |
| `userAddr` | Order owner. Absent: quote-only, `assemblable: false` |
| `slippageLimitPercent` | Signed limit in bips (x100). Above 50%: `INVALID_SLIPPAGE`, never silently clamped |
| `simple` | `true` maps to the fast price quality, `false` to optimal |
| `referralCode` | Integer code becomes Ophis referral code `odos<code>` in the order's appData (attribution + rebates) |
| `referralFee`, `referralFeeRecipient` | When the partner-fee program is enabled: a non-zero fee maps to a CIP-75 Volume `metadata.partnerFee` entry (0.001 = 10 bps), minimum 4 bps (`0.0004`; below that is rejected), capped at 90 bps (`PARTNER_FEE_CAP_EXCEEDED` above it). When disabled: `PARTNER_FEE_UNAVAILABLE`. See Partner fees above |
| `gasPrice` | Ignored + warning (solvers pay gas) |
| `sourceWhitelist` / `sourceBlacklist` / `poolBlacklist` | Ignored + warning: routing is decided by competing solvers |
| `disableRFQs`, `compact` | Silent no-ops |
| `likeAsset` | Ignored + warning |
| `pathViz`, `pathVizImage`, `pathVizImageConfig` | Requested from the Ophis route-visualization service when it is enabled; the graph and rendered SVG come back in `pathViz`/`pathVizImage`. Flag-gated, so it degrades to null with a warning when off |
| `permit2` | Reserved, currently null + warning (one-signature Permit2 onboarding is on the roadmap) |

## Response field mapping

| v3 response field | Ophis value |
|---|---|
| `inTokens`, `outTokens`, `inAmounts`, `outAmounts` | Real quote values (atoms, decimal strings) |
| `gasEstimate`, `dataGasEstimate`, `gweiPerGas`, `gasEstimateValue` | 0 (you pay no gas; embedded solver cost in `ophis.executionCost`) |
| `inValues`, `outValues`, `netOutValue` | Native-denominated floats (`ophis.valueCurrency: "native"`) |
| `priceImpact` | `null` (no independent mid-price feed; nothing is fabricated) |
| `percentDiff` | `0` |
| `permit2Message`, `permit2Hash` | `null` until Permit2 onboarding ships |
| `partnerFeePercent` | Total CIP-75 Volume bps embedded in the order, as a percent: the Ophis protocol fee (0.05 = 5 bps) plus any mapped `referralFee`. Already priced into `outAmounts` |
| `pathId` | Stateless signed token, valid up to 60 s, consumed by `/sor/assemble` |
| `pathViz`, `pathVizImage` | The route-visualization graph and rendered base64 SVG when requested and the feature is enabled, else `null` |
| `blockNumber` | 0 + warning (quotes are auction-based, not block-pinned; use `ophis.expiration`) |
| `ophis.expectedSettlementSeconds` | Typical quote-to-settlement latency in seconds (an estimate, not a guarantee). See Settlement timing |
| `transaction` (assemble/swap) | Always `null`. Sign `ophis.order` instead |
| `simulation` (assemble/swap) | Always `null`; the orderbook re-validates at submit |

## Errors

Errors use one envelope: `{ traceId, error: { code, numericCode, httpStatus,
message, docs } }`. `code` is a stable string (`MULTI_TOKEN_UNSUPPORTED`,
`PARTNER_FEE_CAP_EXCEEDED`, `PATH_ID_EXPIRED`, `NO_ROUTE`, ...);
`numericCode` follows the Ophis API bands (2xxx quoting, 3xxx retryable
upstream, 4xxx validation). Two doctrines to wire into your client:

- `NO_ROUTE` (404) is an answer, not a failure. Retrying it cannot change it.
- 503 responses carry `Retry-After` and are the only in-call retryable class.
  429 means slow down globally; do not retry the same call.

Quote the `traceId` when reporting a problem.

## Worked example: 1,000 USDC to WETH on Optimism

- You quote 1,000 USDC (`1000000000` atoms). The quoted output is
  0.538127 WETH with the 5 bps (0.05%) Ophis fee already priced in;
  `partnerFeePercent: 0.05` reports it.
- With `slippageLimitPercent: 0.3` the draft signs a minimum out of
  0.536512 WETH. That is the worst case you authorize.
- You pay zero gas. The solver's execution cost (about 0.0012 ETH at quote
  time in `ophis.executionCost`) is inside the quoted price, not on top.
- At settlement, solvers compete: if the batch clears better than your signed
  minimum, the difference is surplus and it goes to you. Fills at exactly the
  quoted amount or better are the normal case; the signed minimum is the floor.

## Chains

| chainId | Network | Orderbook |
|---|---|---|
| 10 | Optimism | `https://optimism-mainnet.ophis.fi` (Ophis-operated) |
| 130 | Unichain | `https://unichain-mainnet.ophis.fi` (Ophis-operated) |

Other chains return `UNSUPPORTED_CHAIN` for now. The surface serves
Ophis-operated chains; the set widens as sovereign deployments do.

## Limits and lifetime

- Rate limit: 60 requests per 60 seconds per IP. Need more? Get in touch.
- `pathId` lifetime: up to 60 seconds (never beyond the quote expiration).
- This surface launched as a migration bridge with a 12-month review date. It
  is not announced for sunset, and it will not silently disappear; usage data
  decides its long-term shape.

## Help

- SDK-first integration (no compat layer): [Partner integration](./partners.md)
  and the [intent API](./intent-api.md).
- Agents and MCP: [AI agents](./ai-agents.md).
- Issues: [github.com/ophis-fi/ophis](https://github.com/ophis-fi/ophis/issues).
