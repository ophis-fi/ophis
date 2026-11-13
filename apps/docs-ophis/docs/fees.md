---
id: fees
title: Fees
description: Check Ophis public swap fees, price-improvement capture, private-swap charges and bridge costs.
sidebar_label: Fees
sidebar_position: 3
---

# Fees

Public batch-auction orders carry a 0.01% Ophis base fee plus a capped share of price improvement over the reference quote. Direct routes, private swaps and bridges use the fee treatment below.

:::tip[Example]

On a 100 USDC swap, the Ophis base fee is 0.01 USDC.

:::

## What you pay {/* #the-all-in-cost-per-chain */}

| Component | Ophis-operated chains | Partner-hosted chains (10) |
| --- | --- | --- |
| Ophis base fee | 1 bp (0.01%) | 1 bp (0.01%) |
| Volatile-pair improvement capture | 80%, capped at 99 bps (0.99%) of volume | 80%, capped at 99 bps (0.99%) of volume |
| Stablecoin-pair improvement capture | 50%, capped at 20 bps (0.20%) of volume | 50%, capped at 20 bps (0.20%) of volume |
| Upstream volume fee | None | 0.02%, or 0.003% on correlated pairs such as stablecoins |
| Combined volume fee | 0.01% | 0.03% volatile / 0.013% correlated stables |
| Upstream improvement policy | None | Applies separately |

| Settlement stack | Networks |
| --- | --- |
| Ophis-operated | Optimism, Unichain, Robinhood Chain, Arc |
| Partner-hosted | Ethereum, Arbitrum, Avalanche, Base, BNB Chain, Gnosis, Ink, Linea, Plasma, Polygon |

Gas, liquidity-pool fees, price impact and bridge costs also affect the amount you receive. Review the final quote before signing.

## Price improvement {/* #standard-price-improvement-capture */}

Price improvement is the extra amount a solver finds beyond the reference quote. Ophis keeps 80% of price improvement on volatile pairs, capped at 99 bps of volume, or 50% on stablecoin pairs, capped at 20 bps. You get the rest, including everything above the cap. Surplus is a different measure: it counts from your signed minimum, which includes your slippage allowance.

On Ophis-operated chains, improvement capture applies to **in-market orders**. Limit orders priced away from the market pay only the base fee.

The ten partner-hosted mainnets use CoW Protocol's orderbooks and solver network. Its fees apply in addition to Ophis fees: a volume fee plus quote-improvement or out-of-market surplus fees where eligible. Check the [upstream fee policy](https://docs.cow.fi/governance/fees) and final quote; the combined volume-fee row is not an all-in cost.

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

## Direct swap costs

For a direct wallet route, review the selected quote, displayed Ophis fee and network gas before confirming the transaction. Batch-auction improvement capture does not automatically describe these routes.

## Private swap costs

Private mode charges **0.1% (10 bps) of swap output** to Ophis, plus pool fees, broadcaster fees and applicable shielding or withdrawal costs. This is separate from the public batch-auction schedule. The broadcaster fee depends on the network, transaction and payment mode; review the current quote before authorizing.

## Fee collection {/* #how-its-collected */}

The app and SDK record the base fee and applicable improvement policy in `appData`.

| Setting | Ophis-operated chains | partner-hosted chains |
| --- | --- | --- |
| Base fee in `appData` | 1 bp | 1 bp |
| Improvement capture | Backend policy | CIP-75 `priceImprovementBps` with a `maxVolumeBps` cap |
| Declared fee validation | Backend rejects a declared fee below 1 bp for the Ophis recipient | The hosted backend validates `appData` |

:::tip[Building an integration]

On Ophis-operated chains, write the base fee in `appData` and leave improvement capture to the backend. On partner-hosted chains, include both entries. The [SDK helpers](/partners) handle this distinction.

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
