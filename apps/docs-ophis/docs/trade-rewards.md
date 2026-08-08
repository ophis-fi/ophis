---
sidebar_position: 4
title: Trade rewards
description: Rules and claim flow for the finite Ophis winning-ticket campaign.
---

# Ophis trade rewards

Ophis has prepared a finite reward pilot to study how traders use the product. The campaign is not
active until Ophis publishes the Robinhood Chain distributor address and enables the claim service.
There is no token launch or speculative airdrop.

## Fixed campaign

- 105 winning tickets: 100 worth 1 USDG and 5 worth 10 USDG.
- Total lifetime reward inventory: 150 USDG.
- One ticket per wallet.
- Every issued ticket wins; losing tickets are not created.
- No claim deadline. An assigned reward remains claimable until it is claimed.
- Rewards are paid in USDG on Robinhood Chain, and Ophis sponsors the claim transaction.

The order of denominations is committed before the campaign starts. The unrevealed allocation seed
is held separately from the public commitment so neither a trader nor the relayer can choose a
ticket's denomination after a qualifying swap. Per-ticket odds are not presented in the swap UI.

## Eligibility

A wallet must complete a settled Ophis swap with a priced value of at least **$100** on Ethereum,
BNB Chain, Arbitrum, Optimism, Base, Robinhood Chain, Unichain, Plasma, Ink, Gnosis, Avalanche, or
Polygon after the campaign starts. The indexer accepts only settled trades whose Ophis fee was
verified; unrelated swaps and swaps between the same token do not count. Wallet age and wallet
balance are not eligibility requirements.

Each wallet can receive only one ticket. Ophis may exclude wallets involved in evident self-dealing,
automation abuse, or coordinated attempts to manufacture qualifying volume. Exclusions are reviewed
and recorded by an operator before rewards are assigned.

## Claiming

Connect the qualifying wallet at [swap.ophis.fi/#/rewards](https://swap.ophis.fi/#/rewards). Once the
signed assignment is confirmed on Robinhood Chain, select **Claim**. Ophis submits and pays for the
transaction; the distributor sends USDG directly to the qualifying wallet. A relayer cannot redirect
the payment.

The campaign contract has no owner withdrawal function. The Ophis Safe can pause assignment and
claims during an incident and rotate the offchain reward signer, but cannot sweep the committed USDG.
