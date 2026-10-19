---
id: migrating-from-odos
title: Migrating from Odos
description: Use Odos v3 request fields to quote, sign, and submit ERC-20 swaps through Ophis.
sidebar_label: Migrating from Odos
sidebar_position: 9
---

# Migrating from Odos

Use your Odos v3 quote requests to trade one ERC-20 input for one ERC-20 output through Ophis.

<Cards>
<Card icon="braces" title="Keep your request fields">Send Odos v3 fields and read signing data from the ophis response block.</Card>
<Card icon="key-round" title="Sign with an EOA">Authorize orders with an EIP-712 or ethsign signature.</Card>
<Card icon="clock" title="Track settlement">Submit your signed order and wait for batch-auction settlement.</Card>
</Cards>

## API requirements

| Requirement | Value |
| --- | --- |
| Base URL | `https://compat.ophis.fi` |
| Tokens | One ERC-20 input and one ERC-20 output, exact-in |
| Signing schemes | `eip712` or `ethsign` |
| API access | Keyless |
| Rate limit | 60 requests per 60 seconds per IP and Cloudflare colo |
| Slippage cap | 50% |
| Order lifetime | 20 minutes (`order.validTo = now + 1200s`) |
| `pathId` lifetime | Up to 60 seconds, bounded by quote expiration |

Threshold-ECDSA MPC signers controlling an EOA use the same signing flow. For Safe or other contract-wallet orders, use [Partner integration](/partners).

Use wrapped tokens such as WETH. Native-token inputs or outputs using `0xEeee…EEeE` or the zero address return `UPSTREAM_UNAVAILABLE` (503, numeric 3000); replace the token instead of retrying.

## Supported chains {/* #chains */}

| `chainId` | Network | Orderbook | Runtime check |
| --- | --- | --- | --- |
| 10 | Optimism | `https://optimism-mainnet.ophis.fi` | [Version endpoint](https://optimism-mainnet.ophis.fi/api/v1/version) |
| 130 | Unichain | `https://unichain-mainnet.ophis.fi` | [Version endpoint](https://unichain-mainnet.ophis.fi/api/v1/version) |
| 4663 | Robinhood Chain | `https://robinhood-mainnet.ophis.fi` | [Version endpoint](https://robinhood-mainnet.ophis.fi/api/v1/version) |

Other chains return `UNSUPPORTED_CHAIN` (4903). Use the SDK for Arc and CoW-hosted chains.

## Swap fees

| Fee | Volatile pairs | Stable pairs |
| --- | --- | --- |
| Base | 1 bp (`partnerFeePercent: 0.01`) | 1 bp (`partnerFeePercent: 0.01`) |
| Share of reference-quote improvement | 80% | 50% |
| Improvement cap | 99 bps of volume | 20 bps of volume |

The backend applies improvement capture separately from the appData base fee. Solvers pay settlement gas, with the cost included in quoted amounts and reported in `ophis.executionCost`.

## API endpoints

| Method and path | Result |
| --- | --- |
| `POST /sor/quote/v3` | Quote; include `userAddr` for an unsigned order and signing data |
| `POST /sor/assemble` | Rebuild the unsigned order from `userAddr` and `pathId`; accepts an optional `receiver` override |
| `POST /sor/swap/v3` | Quote and assembly in one call |
| `POST /sor/submit` | Validate and submit your signed order |
| `GET /sor/order-status/10/{orderUid}` | Order status and executed amounts |
| `GET /sor/settlement/{chainId}/{orderUid}?waitSeconds=20` | Wait for settlement or the bounded timeout |
| `/healthz` | Configured chains |

## Get a quote {/* #quote-only-use */}

<Steps>

1. **Set the base URL.** Use `https://compat.ophis.fi`.
2. **Request a quote.** Send `POST /sor/quote/v3` without `userAddr` for price discovery.
3. **Read the quote.** Use the token amounts and the execution cost in the response.

</Steps>

Quote-only responses set `ophis.assemblable` to `false`. The `pathId`, `ophis.order`, `ophis.signing`, and `ophis.fullAppData` fields contain `null`.

## Submit a swap {/* #api-flow */}

<Steps>

1. **Request a signable quote.** Replace the example `userAddr` with your signing account to receive `pathId`, the unsigned order, and its signing envelope.

   ```bash
   curl -sS -X POST https://compat.ophis.fi/sor/quote/v3 \
     -H 'content-type: application/json' \
     -d '{
       "chainId": 10,
       "userAddr": "0x1234567890123456789012345678901234567890",
       "inputTokens":  [{ "tokenAddress": "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", "amount": "1000000000" }],
       "outputTokens": [{ "tokenAddress": "0x4200000000000000000000000000000000000006", "proportion": 1 }],
       "slippageLimitPercent": 0.3
     }'
   ```

2. **Approve and sign.** Approve the chain's Ophis vault relayer for the sell amount, then sign the returned order with its EIP-712 domain.

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

3. **Submit the signed order.** Build `signed-order.json` with the fields below, replacing the placeholders with values from the same quote and your signature.

   ```bash
   curl -sS -X POST https://compat.ophis.fi/sor/submit \
     -H 'content-type: application/json' \
     --data-binary @signed-order.json
   ```

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

4. **Track the order.** Poll until `status` is `fulfilled`, `expired`, or `cancelled`; a fulfilled order includes `txHash` and executed amounts. Use the settlement endpoint below for long-polling.

   ```
   GET /sor/order-status/10/{orderUid}
   ```

</Steps>

| Submission field | Value |
| --- | --- |
| `chainId` | Positive chain ID used for the quote |
| `order`, `fullAppData`, `quoteId` | Copy from the same `quote.ophis` response |
| `signature` | Your signature over that order |
| `signingScheme` | `eip712` for the example above; also the default if omitted |
| `from` | Signing account address |

| Optimism contract | Address |
| --- | --- |
| EIP-712 settlement | `0x310784c7FCE12d578dA6f53460777bAc9718B859` |
| Vault relayer | `0x83847EaB41ad9ea43809ce71569eB2e9daF51830` |

The receiver defaults to your signing account. To send proceeds elsewhere, set `receiver` during assembly and include `acceptNonOwnerReceiver: true` at submission. The relay validates the appData hash, receiver, and amount bounds before forwarding the order.

:::tip[Choose the signed limit]

`slippageLimitPercent` sets the order's limit price for its full lifetime. An order fills at that price or better, or expires. Cancel through the chain's orderbook API if you need to stop an open order.

:::

## Settlement timing

Use the bounded long-poll to wait for a terminal state or a timeout:

```
GET /sor/settlement/{chainId}/{orderUid}?waitSeconds=20
```

| Parameter or field | Value |
| --- | --- |
| `ophis.expectedSettlementSeconds` | Configured planning baseline: `24` |
| `waitSeconds` | Default 20, maximum 55 |
| `pending: true` | Reconnect after `ophis.pollAgainAfterSeconds` |
| Response fields | `settled`, `terminal`, `pending`, `status`, `txHash`, `executedSellAmount`, `executedBuyAmount`, `order`, `trades` |

Use the returned status and settlement amounts to update your app after execution.

## Request field mapping

| v3 request field | Ophis behavior |
| --- | --- |
| `chainId` | 10, 130, or 4663 |
| `inputTokens` | One sell token and exact-in amount; extra entries return `MULTI_TOKEN_UNSUPPORTED` |
| `outputTokens` | One output with `proportion` 1; extra outputs return `MULTI_TOKEN_UNSUPPORTED` |
| `userAddr` | Include the order owner for a signed `pathId`, order draft, and signing envelope; omit for quote-only use |
| `slippageLimitPercent` | Converted to bips (x100); values above 50% return `INVALID_SLIPPAGE` |
| `simple` | `true` selects fast price quality; `false` selects optimal |
| `referralCode` | Integer maps to `odos<code>` in appData for attribution; use a registered referral identity |
| `referralFee`, `referralFeeRecipient` | Omit the fee or set it to zero; a non-zero fee returns `PARTNER_FEE_UNAVAILABLE` |
| `gasPrice` | Ignored with a warning; solvers pay settlement gas |
| `sourceWhitelist`, `sourceBlacklist`, `poolBlacklist` | Ignored with a warning; solvers choose routing |
| `disableRFQs`, `compact` | Ignored |
| `likeAsset` | Ignored with a warning |
| `pathViz`, `pathVizImage`, `pathVizImageConfig` | Route graph and rendered SVG on Optimism; Unichain and Robinhood Chain return `null` with a warning |
| `permit2` | `null` with `PERMIT2_UNAVAILABLE`; approve the vault relayer |

## Response field mapping

| v3 response field | Ophis value |
| --- | --- |
| `inTokens`, `outTokens`, `inAmounts`, `outAmounts` | Quoted values; amounts use atoms as decimal strings |
| `gasEstimate`, `dataGasEstimate`, `gweiPerGas`, `gasEstimateValue` | 0; embedded settlement cost is in `ophis.executionCost` |
| `inValues`, `outValues`, `netOutValue` | Native-token-denominated floats, marked by `ophis.valueCurrency: "native"`; failed price lookups return 0 with `VALUES_UNAVAILABLE`, while atom amounts remain exact |
| `priceImpact` | `null` |
| `percentDiff` | `0` |
| `permit2Message`, `permit2Hash` | `null` |
| `partnerFeePercent` | AppData base as a percent: `0.01` = 1 bp; improvement capture is applied separately |
| `pathId` | Signed token for `/sor/assemble` when `userAddr` is supplied; `null` for quote-only requests |
| `pathViz`, `pathVizImage` | Requested Optimism route graph and base64 SVG; otherwise `null` |
| `blockNumber` | 0 with a warning; use `ophis.expiration` for quote validity |
| `transaction` | `null`; sign `ophis.order` |
| `simulation` | `null`; the orderbook validates at submission |

## Handle API errors {/* #errors */}

Errors use `{ traceId, error: { code, numericCode, httpStatus, message, docs } }`. Match on the string `code` and include `traceId` when reporting a problem.

| Response | Client action |
| --- | --- |
| `NO_ROUTE` (404) | Choose another pair or amount |
| 503 with `Retry-After` | Retry after the delay, except for native-token inputs or outputs |
| 429 | Reduce the request rate globally |
| `PATH_ID_EXPIRED` (410) | Request a new quote |

### Numeric code translation

Translate Odos error handling before switching the base URL. Ophis uses these numeric bands:

| Band | Meaning |
| --- | --- |
| 2xxx | Quoting |
| 3xxx | Retryable upstream errors |
| 4xxx | Validation |
| 5xxx | Server or configuration errors |
| 49xx and 59xx | Compatibility API codes |

| Odos code | Ophis code or response |
| --- | --- |
| 1000 `API_ERROR` | Map by the returned string `code` |
| 2000 `NO_VIABLE_PATH`, 4016 `TOKEN_ROUTING_UNAVAILABLE`, 5001 `SWAP_UNAVAILABLE` | 2000 `NO_ROUTE` (404) |
| 2997/2998/2999 `ALGO_*`, 3000 `INTERNAL_SERVICE_ERROR` | 3000 `UPSTREAM_UNAVAILABLE`; follow `Retry-After` |
| 3100 `CONFIG_INTERNAL` | 3100 means `UPSTREAM_RATE_LIMITED` in Ophis |
| 3110-3112 `TXN_ASSEMBLY_*`, 3140-3143 `GAS_*` | Replace transaction assembly and gas estimation with order signing |
| 4000 `INVALID_REQUEST`, 4007 `SAME_INPUT_OUTPUT` | 4900 `INVALID_REQUEST` |
| 4001 `INVALID_CHAIN_ID` | 4903 `UNSUPPORTED_CHAIN` |
| 4004 / 4010 `INVALID_*_ADDR` | 4905 `INVALID_ADDRESS` |
| 4006 `TOO_SLIPPERY` | 4904 `INVALID_SLIPPAGE` above `MAX_SLIPPAGE_BIPS` |
| 4011/4012/4018/4019 `*_TOKEN_AMOUNT` | 4906 `INVALID_AMOUNT` |
| 4015 `INVALID_TOKEN_PROPORTIONS`, `0 < p < 1` | 4901 `MULTI_TOKEN_UNSUPPORTED` |
| 4015 `INVALID_TOKEN_PROPORTIONS`, `p <= 0`, `p > 1`, or non-numeric | 4900 `INVALID_REQUEST` |
| 4201 `USER_ADDR_REQ` on `/sor/quote/v3` | 200 OK, quote-only response |
| 4201 `USER_ADDR_REQ` on `/sor/swap/v3` | 4911 `NOT_ASSEMBLABLE` |
| 4201 `USER_ADDR_REQ` on `/sor/assemble` | 4905 `INVALID_ADDRESS` |

| Additional Ophis code | Meaning |
| --- | --- |
| 4901 `MULTI_TOKEN_UNSUPPORTED` | Use one input and one whole-share output |
| 4902 `PARTNER_FEE_UNAVAILABLE` | Omit `referralFee` or set it to zero |
| 4908 `PATH_ID_EXPIRED` (410) | Request a new quote |
| 5901 `CONFIG_MISSING` | Report the server configuration error with `traceId` |

Report issues at [github.com/ophis-fi/ophis](https://github.com/ophis-fi/ophis/issues).

## Next

<Cards>
<Card icon="code" title="Partner integration" href="/partners">Use the SDK for contract wallets and CoW-hosted chains.</Card>
<Card icon="braces" title="Intent API" href="/intent-api">Parse natural-language swap requests.</Card>
<Card icon="bot" title="AI agents" href="/ai-agents">Connect an agent through the Ophis MCP server.</Card>
</Cards>
