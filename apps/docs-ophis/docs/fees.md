---
id: fees
title: Fees
description: Ophis charges a base fee plus capped price-improvement capture, with separate CoW Protocol and bridge costs.
sidebar_label: Fees
sidebar_position: 3
---

# Fees

Ophis charges a 0.01% base fee plus a capped share of any price improvement over the reference quote.

:::tip[Example]

On a 100 USDC swap, the Ophis base fee is 0.01 USDC.

:::

## What you pay {/* #the-all-in-cost-per-chain */}

| Component | Ophis-operated chains | CoW-hosted chains (10) |
| --- | --- | --- |
| Ophis base fee | 1 bp (0.01%) | 1 bp (0.01%) |
| Volatile-pair improvement capture | 80%, capped at 99 bps (0.99%) of volume | 80%, capped at 99 bps (0.99%) of volume |
| Stablecoin-pair improvement capture | 50%, capped at 20 bps (0.20%) of volume | 50%, capped at 20 bps (0.20%) of volume |
| CoW Protocol volume fee | None | 0.02%, or 0.003% on correlated pairs such as stablecoins |
| Total volume fee (Ophis and CoW) | 0.01% | 0.03% volatile / 0.013% correlated stables |
| CoW Protocol improvement policy | None | Applies separately |

| Settlement stack | Networks |
| --- | --- |
| Ophis-operated | Optimism, Unichain, Robinhood Chain, Arc |
| CoW-hosted | The other 10 mainnets |

Gas, liquidity-pool fees, price impact and bridge costs also affect the amount you receive. Review the final quote before signing.

## Price improvement {/* #standard-price-improvement-capture */}

Price improvement is the extra amount a solver finds beyond the reference quote. Ophis keeps the share shown above, up to the cap, and you get the rest, including everything above the cap. Surplus is a different measure: it counts from your signed minimum, which includes your slippage allowance.

On Ophis-operated chains, improvement capture applies to **in-market orders**. Limit orders priced away from the market pay only the base fee.

On CoW-hosted chains, CoW Protocol applies its own fees before the Ophis fee, and the quote shows the result. See [CoW's fee policy](https://docs.cow.fi/governance/fees).

<span id="arc-release-exception" />

## Arc fee policy {/* #arc-price-improvement-policy */}

Arc follows the same rules as the other Ophis-operated chains, and USDC/EURC counts as a stablecoin pair. Whether an order is in-market depends on its price compared with its reference quote, including orders entered as limit orders.

## Bridge costs {/* #bridge-and-conversion-routes */}

| Route | Fee treatment |
| --- | --- |
| NEAR Intents, including external deposits | 3 bps Ophis app fee plus provider costs in the quote |
| Direct NEAR deposit | Uses the NEAR quote's fees |
| Direct Circle bridge | Uses the route quote's fees |
| Source approval, deposit and destination execution | Network gas costs |

See [Networks & assets](/networks-assets) for funding and recovery requirements.

## Fee collection {/* #how-its-collected */}

The app and SDK use CoW Protocol's partner-fee model to record fees in `appData`.

| Setting | Ophis-operated chains | CoW-hosted chains |
| --- | --- | --- |
| Base fee in `appData` | 1 bp | 1 bp |
| Improvement capture | Backend policy | CIP-75 `priceImprovementBps` with a `maxVolumeBps` cap |
| Declared fee validation | Backend rejects a declared fee below 1 bp for the Ophis recipient | CoW's backend validates `appData` |

:::tip[Building an integration]

On Ophis-operated chains, write the base fee in `appData` and leave improvement capture to the backend. On CoW-hosted chains, include both entries. The [SDK helpers](/partners) handle this distinction.

:::

<span id="what-you-save-versus-a-typical-amm" />

## Compare execution costs {/* #comparing-execution-costs */}

Compare the final amount received for the same token pair and trade size, including wallet gas. Solver routes that use an AMM also incur its pool fees.

## Next

<Cards>
<Card icon="globe" title="Networks and assets" href="/networks-assets">Check the settlement and bridge path for your trade.</Card>
<Card icon="braces" title="SDK integration" href="/partners">Build orders with the fee metadata for your chain.</Card>
<Card icon="gift" title="Trade rewards" href="/trade-rewards">See the USDG campaign and claim steps.</Card>
</Cards>
