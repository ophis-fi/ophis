---
id: migrating-from-odos
title: Migrating from Odos
description: Current production status and field mapping for the Odos v3-compatible quote surface at compat.ophis.fi.
sidebar_label: Migrating from Odos
sidebar_position: 9
---

# Migrating from Odos

Ophis runs a compatibility surface for integrators who built against the Odos
v3 API. It accepts the request shape you already send (PathRequestV3 field
names, single token in and single token out) and answers with the
QuoteResponse field surface you already parse, plus a namespaced `ophis` block.

"Odos" is used on this page in its plain factual sense, to describe the wire
shape this surface accepts. Ophis is an independent protocol.

## Production status

As verified against `https://compat.ophis.fi` on 30 July 2026:

- The health endpoint reports chains 10, 130, and 4663 as enabled.
- A `POST /sor/quote/v3` request with `userAddr` was verified on chain 10. It
  returned HTTP 200, a signed `pathId`, `ophis.assemblable: true`, the unsigned
  order, and its EIP-712 signing envelope.
- Quote-only requests without `userAddr` remain supported and return
  `ophis.assemblable: false`.
- Integrator-priced `referralFee` is disabled in production and returns
  `PARTNER_FEE_UNAVAILABLE`.

## Quote-only use

1. Change your base URL to `https://compat.ophis.fi`.
2. Send `POST /sor/quote/v3` without `userAddr`.
3. Read live quote fields from the response. Quote-only responses intentionally
   omit the `pathId`, order, and signing envelope.

## What is the same

| Piece | Status |
|---|---|
| `POST /sor/quote/v3` request field names | Accepted as-is (single input, single output) |
| `POST /sor/assemble` with `userAddr` + `pathId` | Live; rebuilds the unsigned order from the signed, expiring `pathId` |
| `POST /sor/swap/v3` (quote + assembly in one call) | Live |
| QuoteResponse fields (`inAmounts`, `outAmounts`, `netOutValue`, `pathId`, ...) | Response fields are present; `pathId` is populated for assemblable requests with `userAddr` and null for quote-only requests |
| `referralCode` attribution | Works today; the integer code becomes the Ophis referral code `odos<code>` |
| Slippage (`slippageLimitPercent`) | Applied to the draft when assembly is available; hard cap 50% |

## What changes, stated plainly

Ophis is an intent protocol settled by competitive batch auctions, not a
router that returns calldata. Three consequences are structural and this
surface does not paper over them:

1. **No `transaction` object, ever.** `/sor/assemble` and `/sor/swap/v3`
   return `transaction: null`. The signable artifact is `ophis.order`, an
   EIP-712 CoW-style order. If your integration composes swap calldata inside
   your own contract call (atomic same-transaction execution), this surface
   does not cover that today.
2. **Settlement is asynchronous.** You submit a signed order, a solver wins
   it in a batch auction, and the settlement lands one or more blocks later.
   The order expires at `order.validTo` (the compat draft uses 20 minutes) if
   it cannot be filled at your limit. Orders settle at the clearing price; an
   execution better than your signed minimum is reflected in the executed
   amounts returned by the orderbook.
3. **You pay no gas.** `gasEstimate`, `gweiPerGas` and `gasEstimateValue` are
   0 because you broadcast nothing. The winning solver pays settlement gas and
   that cost is already priced into the quoted amounts. The embedded estimate
   is visible in `ophis.executionCost`.

One smaller deviation:

- **Values are native-denominated, not USD.** `inValues`, `outValues` and
  `netOutValue` are denominated in the chain's native token and
  `ophis.valueCurrency: "native"` says so. `percentDiff` is pinned to 0 and
  `priceImpact` to null rather than fabricated from a feed Ophis does not
  have. If either native-price lookup fails, these display values are 0 and the
  response includes a `VALUES_UNAVAILABLE` warning; atom-denominated amounts
  remain exact.

## Settlement timing

Because settlement is asynchronous, the quote response carries
`ophis.expectedSettlementSeconds`. The deployed worker currently returns the
configured value `24`. This is a static planning baseline, not a measurement,
prediction, guarantee, or SLA. Use order status as the source of truth.

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

The production compat worker currently has integrator-priced partner fees
disabled. Any non-zero `referralFee` returns
`PARTNER_FEE_UNAVAILABLE`; it is not silently dropped. `referralCode`
attribution remains enabled and maps the integer to `odos<code>`.

The code path for mapping `referralFee` to a CIP-75 Volume fee exists behind
the deployment switch, but it is not a production capability while that switch
is off. See [Partner integration](./partners.md) for the currently supported
partner-fee integration.

## API flow

### 1. Quote

```bash
curl -sS -X POST https://compat.ophis.fi/sor/quote/v3 \
  -H 'content-type: application/json' \
  -d '{
    "chainId": 10,
    "inputTokens":  [{ "tokenAddress": "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", "amount": "1000000000" }],
    "outputTokens": [{ "tokenAddress": "0x4200000000000000000000000000000000000006", "proportion": 1 }],
    "slippageLimitPercent": 0.3
  }'
```

The production response carries Odos-compatible quote fields plus metadata in
the `ophis` block. Amounts, quote IDs, expiration, execution cost, and
native-denominated display values come from the live orderbook response; this
guide does not publish fixed sample output for them. With no `userAddr`,
`pathId`, `ophis.order`, `ophis.signing`, and `ophis.fullAppData` are `null`.

Add `userAddr` to request an assemblable quote containing a signed `pathId`,
unsigned order, and EIP-712 signing envelope.

### 2. Sign

`/sor/assemble` rebuilds the unsigned draft from the `pathId` (`userAddr` +
`pathId`, with an optional `receiver` override). An assemblable quote also
contains the draft directly. Sign it as EIP-712 typed data:

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
  --data-binary @signed-order.json
```

Build `signed-order.json` from that same quote. The submit envelope must have
this shape (the values below are placeholders):

```json
{
  "chainId": 10,
  "order": {
    "sellToken": "0x...",
    "buyToken": "0x...",
    "receiver": "0x...",
    "sellAmount": "...",
    "buyAmount": "...",
    "validTo": 0,
    "appData": "0x...",
    "feeAmount": "0",
    "kind": "sell",
    "partiallyFillable": false,
    "sellTokenBalance": "erc20",
    "buyTokenBalance": "erc20"
  },
  "signature": "0x...",
  "signingScheme": "eip712",
  "from": "0x...",
  "fullAppData": "...",
  "quoteId": 0
}
```

Set the positive top-level `chainId` to the chain used for the quote, copy
`order`, `fullAppData`, and `quoteId` from `quote.ophis`, put the actual
signature in `signature`, and put the signing account address under the exact
`from` key. Do not reuse values from another quote. `signingScheme` defaults to
`eip712` when omitted; include it explicitly as shown when using the typed-data
signature from the preceding step.

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
| `chainId` | Must be an enabled Ophis-operated chain (10, 130, or 4663) |
| `inputTokens` | Exactly one entry: sell token + amount (exact-in). More than one returns `MULTI_TOKEN_UNSUPPORTED` |
| `outputTokens` | Exactly one entry, `proportion` 1. Multiple outputs return `MULTI_TOKEN_UNSUPPORTED` |
| `userAddr` | Order owner. Absent: quote-only, `assemblable: false`. Present: signed `pathId`, order draft, and signing envelope |
| `slippageLimitPercent` | Signed limit in bips (x100). Above 50%: `INVALID_SLIPPAGE`, never silently clamped |
| `simple` | `true` maps to the fast price quality, `false` to optimal |
| `referralCode` | Integer code becomes Ophis referral code `odos<code>` in the order's appData (attribution + rebates) |
| `referralFee`, `referralFeeRecipient` | Production switch is currently off: a non-zero fee returns `PARTNER_FEE_UNAVAILABLE` |
| `gasPrice` | Ignored + warning (solvers pay gas) |
| `sourceWhitelist` / `sourceBlacklist` / `poolBlacklist` | Ignored + warning: routing is decided by competing solvers |
| `disableRFQs`, `compact` | Silent no-ops |
| `likeAsset` | Ignored + warning |
| `pathViz`, `pathVizImage`, `pathVizImageConfig` | Requested from the Ophis route-visualization service when it is enabled; the graph and rendered SVG come back in `pathViz`/`pathVizImage`. Flag-gated, so it degrades to null with a warning when off |
| `permit2` | Currently null + `PERMIT2_UNAVAILABLE` warning; approve the vault relayer instead |

## Response field mapping

| v3 response field | Ophis value |
|---|---|
| `inTokens`, `outTokens`, `inAmounts`, `outAmounts` | Real quote values (atoms, decimal strings) |
| `gasEstimate`, `dataGasEstimate`, `gweiPerGas`, `gasEstimateValue` | 0 (you pay no gas; embedded solver cost in `ophis.executionCost`) |
| `inValues`, `outValues`, `netOutValue` | Native-denominated floats (`ophis.valueCurrency: "native"`) |
| `priceImpact` | `null` (no independent mid-price feed; nothing is fabricated) |
| `percentDiff` | `0` |
| `permit2Message`, `permit2Hash` | `null` |
| `partnerFeePercent` | Total CIP-75 Volume bps embedded in the order, as a percent. With the current production fee switch off, this is the Ophis fee (`0.05` = 5 bps). Already priced into `outAmounts` |
| `pathId` | Currently `null` on successful production quotes. When path-ID signing is configured: a stateless token valid up to 60 s and consumed by `/sor/assemble` |
| `pathViz`, `pathVizImage` | The route-visualization graph and rendered base64 SVG when requested and the feature is enabled, else `null` |
| `blockNumber` | 0 + warning (quotes are auction-based, not block-pinned; use `ophis.expiration`) |
| `ophis.expectedSettlementSeconds` | Static deployment baseline, currently `24`; not measured latency or an SLA. See Settlement timing |
| `transaction` (assemble/swap) | Always `null`. Sign `ophis.order` instead |
| `simulation` (assemble/swap) | Always `null`; the orderbook re-validates at submit |

## Errors

Errors use one envelope: `{ traceId, error: { code, numericCode, httpStatus,
message, docs } }`. `code` is a stable string (`MULTI_TOKEN_UNSUPPORTED`,
`PARTNER_FEE_CAP_EXCEEDED`, `PATH_ID_EXPIRED`, `NO_ROUTE`, `CONFIG_MISSING`,
...). `numericCode` follows the Ophis API bands (2xxx quoting, 3xxx retryable
upstream, 4xxx validation, and 5xxx server/configuration errors). Two doctrines
to wire into your client:

- `NO_ROUTE` (404) is an answer, not a failure. Retrying it cannot change it.
- 503 responses carry `Retry-After` and are the only in-call retryable class.
  429 means slow down globally; do not retry the same call.

Quote the `traceId` when reporting a problem.

## Chains

| chainId | Network | Orderbook |
|---|---|---|
| 10 | Optimism | `https://optimism-mainnet.ophis.fi` (Ophis-operated) |
| 130 | Unichain | `https://unichain-mainnet.ophis.fi` (Ophis-operated) |

Other chains return `UNSUPPORTED_CHAIN`.

## Limits and lifetime

- Best-effort edge rate limit: 60 requests per 60 seconds per IP and
  Cloudflare colo. Need more? Get in touch.
- `pathId` lifetime: up to 60 seconds (never beyond the quote expiration).

## Help

- SDK-first integration (no compat layer): [Partner integration](./partners.md)
  and the [intent API](./intent-api.md).
- Agents and MCP: [AI agents](./ai-agents.md).
- Issues: [github.com/ophis-fi/ophis](https://github.com/ophis-fi/ophis/issues).
