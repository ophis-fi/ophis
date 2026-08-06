---
id: migrating-from-odos
title: Migrating from Odos
description: Current production status and field mapping for the Odos v3-compatible quote surface at compat.ophis.fi.
sidebar_label: Migrating from Odos
sidebar_position: 9
---

# Migrating from Odos

:::tip[Start here: this is probably not your page]

This page documents one narrow surface: the Odos v3 **quote shape**, signed by
an **EOA**, on an **Ophis-operated chain**. Four common integrations look like
they belong here and do not. Check this table before you read further.

| If this is you | Go here instead |
|---|---|
| Your signature is validated by a **contract**: a Safe, a smart account, a vault, an MPC signer behind EIP-1271, or a DAO treasury module | **[Partner integration (SDK)](./partners.md).** This surface accepts only `eip712` and `ethsign` and rejects `presign` and `eip1271`, so a contract-validated signer has no path here at all. The SDK reaches those schemes directly |
| You trade on **Ethereum, Base, Arbitrum, or any other CoW-hosted chain** | **[Partner integration (SDK)](./partners.md).** This surface serves only chains 10, 130 and 4663. The SDK covers those three plus every CoW-hosted chain |
| You trade mostly **same-chain stable pairs** | This surface and the **[Partner integration (SDK)](./partners.md)** both use the 1 bp sovereign base; the SDK also covers hosted chains |
| You compose swap **calldata inside your own contract call** | Neither page. Ophis returns an intent, not a transaction, and that is a settlement-model difference rather than a backlog item. See [What this surface is](#what-this-surface-is-and-what-it-is-not) |

A vault rebalancing console, a treasury tool, or anything that signs as a
contract is exactly the case the SDK guide was written for, even though the
word "Odos" does not appear in its title.

If none of the four rows describe you, you are in the right place: read on.

:::

## What this surface is, and what it is not

This is a **quote-shape compatibility layer**, not a general migration path off
Odos. Read that sentence before you plan any work.

It accepts the Odos v3 request shape you already send (PathRequestV3 field
names, single token in and single token out) and answers with the QuoteResponse
field surface you already parse, plus a namespaced `ophis` block. Within a
narrow envelope it will also carry you through signing and submission.

The envelope is genuinely narrow, and the boundaries are structural rather than
a backlog:

| You need | Supported |
|---|---|
| Server-side price discovery, ERC-20 to ERC-20 | Yes |
| Execution from an EOA, ERC-20 to ERC-20, on an enabled chain | Yes |
| Executable calldata to compose inside your own contract call | **No, and not planned.** Ophis returns an intent, not a transaction |
| Signing from a Safe, smart account, MPC or DAO treasury | **No.** EOA signing schemes only |
| Native ETH in or out | **No** |
| Multi-token in or out | **No.** Tracked with basket intents |
| Zaps, limit orders, protected swaps, Solana | **No** |
| The other 14 Odos endpoints (`/info/*`, `/pricing/*`, `/zap/*`) | **No.** 3 of 17 Odos paths are implemented |

If you are composing swap calldata inside your own contract, this surface
cannot serve you and no amount of future work will change that: the difference
is the settlement model, not the API. Use the
[SDK-first integration](./partners.md) or the [intent API](./intent-api.md)
instead, or stay with a router-based aggregator.

"Odos" is used on this page in its plain factual sense, to describe the wire
shape this surface accepts. Ophis is an independent protocol, not a successor
to or affiliate of Odos.

## Production status

As verified against `https://compat.ophis.fi` and its orderbook dependencies on
5 August 2026:

- `/healthz` reports chains 10, 130 and 4663 as enabled.
- A `POST /sor/quote/v3` request with `userAddr` was verified on chain 10. It
  returned HTTP 200, a signed `pathId`, `ophis.assemblable: true`, the unsigned
  order, and its EIP-712 signing envelope.
- Quote-only requests without `userAddr` remain supported and return
  `ophis.assemblable: false`.
- **Chain 130 (Unichain) is not answering.** Its orderbook host is down, so
  quotes for 130 return `UPSTREAM_UNAVAILABLE` (503). This is an outage, not a
  removal: re-check rather than dropping 130 from your config. Chains 10 and
  4663 are unaffected.
- Integrator-priced `referralFee` is disabled in production and returns
  `PARTNER_FEE_UNAVAILABLE`.

## Pricing, for comparison

The compat surface serves only Ophis-operated chains, so it embeds the **1 bp
sovereign base** (`partnerFeePercent: 0.01`) on every pair. The sovereign backend
then applies the current price-improvement policy: 80% of reference-quote
improvement on volatile pairs capped at 50 bps of volume, or 50% on stable pairs
capped at 20 bps. There is no API key, paid tier, or daily request cap; the only
limit is a best-effort 60 requests per 60 seconds per IP and Cloudflare colo.

## Quote-only use

1. Change your base URL to `https://compat.ophis.fi`.
2. Send `POST /sor/quote/v3` without `userAddr`.
3. Read live quote fields from the response. On a quote-only response the keys
   are all still present and explicitly `null`: top-level `pathId`, plus
   `ophis.order`, `ophis.signing` and `ophis.fullAppData`. Nothing is omitted,
   so a parser that distinguishes a missing key from a null value sees a null.
   `ophis.assemblable` is `false`.

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

Four more that will bite you in production if you do not plan for them:

4. **Contract-wallet signing schemes are not exposed.** `signingScheme` accepts
   `eip712` or `ethsign` and rejects anything else with `INVALID_REQUEST`. CoW's
   `presign` and `eip1271` are not available, so **anything whose signature is
   validated by a contract has no path here**: a Safe, a smart account, or a
   DAO treasury module. This is a regression versus Odos, whose limit-order
   router shipped a signature validator and tested contract wallets. Use the
   [SDK](./partners.md), which reaches those schemes directly.

   This is about *who validates the signature*, not about key custody. A
   threshold-ECDSA MPC signer that controls an ordinary EOA produces a standard
   EIP-712 or `ethsign` signature and works here unchanged.
5. **Native ETH is not supported, in or out.** There is no ethflow wrapping on
   this surface. Both the `0xEeee…EEeE` sentinel and the zero address are
   forwarded to the orderbook as if they were ERC-20s and currently surface as
   `UPSTREAM_UNAVAILABLE` (503, numeric 3000). **Do not build a retry loop on
   that response for a native-token pair.** 503 is documented below as the
   retryable class, and for this input it is not: retrying cannot succeed. Use
   the wrapped token (WETH and its per-chain equivalent) explicitly.
6. **`slippageLimitPercent` is not a revert bound.** On Odos it meant "revert
   the transaction if the price moves past this". Here it sets the limit price
   you sign into an order that then **rests for 20 minutes**
   (`order.validTo = now + 1200s`). Nothing reverts. The order either fills at
   or better than your limit within that window, or it expires. A value you
   chose for revert semantics is usually the wrong value for a resting limit.
7. **There is no cancel endpoint.** Once submitted, an order rests until it
   fills or `validTo` passes. If you need to cancel, use the orderbook API for
   the chain directly, or size `slippageLimitPercent` knowing you are committed
   for the full 20 minutes.

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
| `partnerFeePercent` | CIP-75 sovereign base embedded in the order, as a percent (`0.01` = 1 bp). The backend's capped price-improvement policy is separate and is not represented as another appData Volume entry |
| `pathId` | A stateless signed token, valid up to 60 s and consumed by `/sor/assemble`. Populated when the request carried `userAddr`; explicitly `null` (not omitted) on a quote-only request |
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
  429 means slow down globally; do not retry the same call. The one exception
  is a native-token pair, which returns 503 but can never succeed (see point 5
  above).

Quote the `traceId` when reporting a problem.

### Numeric code translation

**The numeric bands do not mean the same thing on both sides.** If you switched
the base URL and kept your error handling, translate before you ship. The
dangerous one is 3000.

| Odos | Meaning on Odos | Ophis | Meaning here | Client action must change? |
|---|---|---|---|---|
| 1000 `API_ERROR` | generic failure | varies | no single equivalent | Map per case |
| **2000** `NO_VIABLE_PATH` | no path found | **2000** `NO_ROUTE` (404) | no solver quoted it | No. The only aligned code |
| 2997/2998/2999 `ALGO_*` | quoting engine down or timed out | 3000 `UPSTREAM_UNAVAILABLE` | orderbook unreachable | Retry class changes |
| **3000** `INTERNAL_SERVICE_ERROR` | **internal failure, give up** | **3000** `UPSTREAM_UNAVAILABLE` | **transient, retry with `Retry-After`** | **Yes. Same number, opposite instruction** |
| 3100 `CONFIG_INTERNAL` | config service failed | 3100 `UPSTREAM_RATE_LIMITED` | upstream is rate limiting us | **Yes. Same number, unrelated meaning** |
| 3110-3112 `TXN_ASSEMBLY_*` | assembly failed | n/a | nothing is assembled here | Delete the branch |
| 3140-3143 `GAS_*` | gas estimation failed | n/a | you pay no gas | Delete the branch |
| 4000 `INVALID_REQUEST` | malformed body | **4900** `INVALID_REQUEST` | same condition | Number changes |
| 4001 `INVALID_CHAIN_ID` | unknown chain | **4903** `UNSUPPORTED_CHAIN` | chain not enabled here | Number changes |
| 4004 / 4010 `INVALID_*_ADDR` | bad address | 4905 `INVALID_ADDRESS` | same condition | Number changes |
| 4006 `TOO_SLIPPERY` | slippage unrealistic | 4904 `INVALID_SLIPPAGE` | above `MAX_SLIPPAGE_BIPS` | Number changes, and see point 6 |
| 4007 `SAME_INPUT_OUTPUT` | tokens identical | 4900 `INVALID_REQUEST` | same condition | Number changes |
| 4011/4012/4018/4019 `*_TOKEN_AMOUNT` | bad amount | 4906 `INVALID_AMOUNT` | same condition | Number changes |
| 4015 `INVALID_TOKEN_PROPORTIONS` (`0 < p < 1`) | proportions do not sum to 1 | **4901** `MULTI_TOKEN_UNSUPPORTED` | a partial share is a split intent | **Different code and class** |
| 4015 `INVALID_TOKEN_PROPORTIONS` (`p <= 0`, `p > 1`, non-numeric) | same on Odos | 4900 `INVALID_REQUEST` | malformed, not unsupported | Number changes |
| 4016 `TOKEN_ROUTING_UNAVAILABLE` | no route for the pair | 2000 `NO_ROUTE` | same meaning, different band | Band changes |
| 4201 `USER_ADDR_REQ` on `/sor/quote/v3` | `userAddr` missing | **200 OK** | quote-only is a supported mode, not an error | **Delete the branch** |
| 4201 `USER_ADDR_REQ` on `/sor/swap/v3` | `userAddr` missing | **4911** `NOT_ASSEMBLABLE` | needs an owner to draft an order for | Different code |
| 4201 `USER_ADDR_REQ` on `/sor/assemble` | `userAddr` missing | **4905** `INVALID_ADDRESS` | fails address validation | Different code |
| 5001 `SWAP_UNAVAILABLE` | route unavailable | 2000 `NO_ROUTE` | same meaning, different band | Band changes |
| n/a | none | **4901** `MULTI_TOKEN_UNSUPPORTED` | multi-token, or a single output whose proportion is neither 1 nor a whole share | New branch |
| n/a | none | **4902** `PARTNER_FEE_UNAVAILABLE` | integrator fees are off on this deployment | New branch |
| n/a | none | **4908** `PATH_ID_EXPIRED` (410) | re-quote, do not retry | New branch |
| n/a | none | **5901** `CONFIG_MISSING` | server misconfigured, not your fault | New branch. Report it with the `traceId` |

Compat-specific codes sit at 49xx and 59xx precisely so they can never collide
with an orderbook-issued code. That also means **almost none of them match the
Odos number for the same condition**.

**Match on the string `code`, not `numericCode`.** The strings are stable and
mean one thing each. The numbers collide across the two systems, and 3000 is a
"give up" on Odos and a "retry" here.

## Chains

| chainId | Network | Orderbook | Status |
|---|---|---|---|
| 10 | Optimism | `https://optimism-mainnet.ophis.fi` (Ophis-operated) | Answering |
| 130 | Unichain | `https://unichain-mainnet.ophis.fi` (Ophis-operated) | **Host down, returns 503** |
| 4663 | Robinhood Chain | `https://robinhood-mainnet.ophis.fi` (Ophis-operated) | Answering |

Other chains return `UNSUPPORTED_CHAIN` (4903), including chains Ophis serves
through CoW-hosted orderbooks. Only the Ophis-operated sovereign chains are
exposed here.

Odos served 14 chains. If your volume was on Ethereum, Base, Arbitrum,
Avalanche, BSC, Polygon, Linea, Sonic, Fraxtal, zkSync Era, Mantle or Mode,
this surface does not cover it.

## Limits and lifetime

- Best-effort edge rate limit: 60 requests per 60 seconds per IP and
  Cloudflare colo. Need more? Get in touch.
- `pathId` lifetime: up to 60 seconds (never beyond the quote expiration).

## Help

- SDK-first integration (no compat layer): [Partner integration](./partners.md)
  and the [intent API](./intent-api.md).
- Agents and MCP: [AI agents](./ai-agents.md).
- Issues: [github.com/ophis-fi/ophis](https://github.com/ophis-fi/ophis/issues).
