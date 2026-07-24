---
name: ophis-surplus-report
description: Report how much surplus (price improvement beyond the signed minimum) a wallet has earned from Ophis trades, in total and per order. Read-only, never signs and never broadcasts. Use when the user asks "how much surplus have I earned", "how much better did Ophis do than my limit", or wants a summary of recent fills.
license: MIT
---

# ophis-surplus-report: what the batch auction gave back (read-only)

## When to use

The user wants evidence, not adjectives: how much better their trades
settled than the minimums they signed. Surplus is the difference between
the signed limit and the actual clearing price; on the Ophis-operated
chains 100% of it goes to the trader.

## Inputs you need

- **chainId**: 10 or 130.
- **address**: the wallet to report on.

## Total surplus

```bash ci:live-readonly
ORDERBOOK="https://optimism-mainnet.ophis.fi"
address="0x858f0F5eE954846D47155F5203c04aF1819eCeF8"

curl -sS "$ORDERBOOK/api/v1/users/$address/total_surplus" | jq -e '.totalSurplus | type == "string"' > /dev/null &&
curl -sS "$ORDERBOOK/api/v1/users/$address/total_surplus" | jq -r '.totalSurplus'
```

`totalSurplus` is a decimal string denominated in the chain's native
currency, in wei (the backend prices each fill's improvement into the
native token at settlement time). Capture it and convert for display:

```bash
totalSurplusWei=$(curl -sS "$ORDERBOOK/api/v1/users/$address/total_surplus" | jq -r '.totalSurplus')
python3 -c "print(int('$totalSurplusWei') / 1e18, 'ETH')"
```

## Per-order breakdown (recent fills)

```bash
orders=$(curl -sS "$ORDERBOOK/api/v1/account/$address/orders?limit=20")

echo "$orders" | jq -r '
  .[] | select(.status == "fulfilled") |
  [.uid[0:10], .kind, .sellToken[0:10], .buyToken[0:10],
   .sellAmount, .buyAmount, .executedSellAmount, .executedBuyAmount]
  | @tsv'
```

Per order, the improvement against the signed limit (do the math in
`python3`, amounts overflow shell and jq numbers):

- **sell order**: surplus in buy-token units =
  `executedBuyAmount - buyAmount` (they signed a minimum out; anything
  above it is surplus).
- **buy order**: surplus in sell-token units =
  `sellAmount - executedSellAmount` (they signed a maximum in; anything
  unspent is surplus).

## What to report back to the user

Lead with the total, then the best example:

> "This wallet has earned 0.0042 ETH of surplus on Optimism to date. Best
> single fill: your 0.5 WETH sell settled 3.1 USDC above the minimum you
> signed. Surplus is price improvement returned to you, not a rebate: the
> batch auction cleared better than your limit and the difference is yours
> by construction."

For a cross-chain picture, run the same report per chain and sum in prose
(never sum wei across chains whose native tokens differ in price).

## Errors

- An address with no trade history returns `totalSurplus: "0"`, not an
  error; report zero plainly.
- `404` on the account orders route means a malformed address, not an empty
  history.
