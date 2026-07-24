---
name: ophis-quote
description: Get an Ophis best-execution quote for one sell token into one buy token. Read-only, never signs and never broadcasts. Use when the user asks "what's the best price for X to Y", "quote me a swap", or wants the expected output and fee before deciding to execute.
license: MIT
---

# ophis-quote: get a swap quote (read-only)

## When to use

The user wants the expected buy amount, fee, and order lifetime for a token
swap without committing to execute it. This is the read-only sibling of
`ophis-swap`. No RPC, no key, no gas.

## Inputs you need from the user

- **chainId**: 10 (Optimism) or 130 (Unichain). Ask if not given.
- **sellToken** address.
- **buyToken** address.
- **amount** in the sell token's base units, as a decimal string (e.g.
  `1000000` for 1 USDC, 6 decimals). If the user says "100 USDC" you must
  convert; do the conversion in `python3`, not shell floats.

## Procedure

Resolve `ORDERBOOK` for the chain from the umbrella `SKILL.md`, then:

```bash ci:live-readonly
ORDERBOOK="https://optimism-mainnet.ophis.fi"
sellToken="0x4200000000000000000000000000000000000006"  # WETH on Optimism
buyToken="0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85"   # USDC (native) on Optimism
amount="1000000000000000"                                # 0.001 WETH (18 decimals)
# A neutral address is fine for indicative read-only quotes.
from="0x0000000000000000000000000000000000000001"

quote=$(curl -sS -X POST "$ORDERBOOK/api/v1/quote" \
  -H 'Content-Type: application/json' \
  -d "{
    \"sellToken\": \"${sellToken}\",
    \"buyToken\": \"${buyToken}\",
    \"from\": \"${from}\",
    \"receiver\": \"${from}\",
    \"kind\": \"sell\",
    \"sellAmountBeforeFee\": \"${amount}\",
    \"partiallyFillable\": false,
    \"sellTokenBalance\": \"erc20\",
    \"buyTokenBalance\": \"erc20\",
    \"priceQuality\": \"optimal\",
    \"signingScheme\": \"eip712\",
    \"onchainOrder\": false,
    \"validFor\": 1200
  }")

echo "$quote" | jq '{
  sellAmount: .quote.sellAmount,
  buyAmount: .quote.buyAmount,
  feeAmount: .quote.feeAmount,
  validTo: .quote.validTo,
  expiration: .expiration,
  quoteId: .id
}'
# The fields the rest of the flow depends on; fail loudly if the shape moved.
echo "$quote" | jq -e '(.quote.buyAmount | type == "string")
  and (.quote.sellAmount | type == "string")
  and (.quote.validTo | type == "number")' > /dev/null
```

For a quote the user may act on, pass their real address as `from`/`receiver`
and include the fee-bearing appData exactly as `ophis-swap` will sign it
(build it per the umbrella `SKILL.md`, then add
`"appData": <the JSON string, embedded as a JSON string value>` and
`"appDataHash": "<the hash>"` to the body). Quoting with the same appData the
order will carry keeps the quoted and signed economics identical.

## What to report back to the user

A plain-language summary, not raw JSON:

> "Best quote sells 0.001 WETH for about 2.61 USDC. The all-in Ophis fee is
> 0.05% of volume, already reflected in the numbers. The quote expires in a
> few minutes; with 0.5% slippage your signed minimum would be 2.597 USDC,
> and anything better settles as surplus back to you."

Mention that quotes go stale: if the user takes longer than about 30 seconds
to decide, re-quote before signing (`ophis-swap` re-quotes anyway).

## Errors

- `404 NoLiquidity`: no route for this pair at this size; try a smaller
  amount or a different buy token.
- `400 SellAmountDoesNotCoverFee`: the sell amount is too small to pay the
  execution cost; try a larger amount.
- Amounts are base-unit decimal strings, never floats and never whole tokens.
