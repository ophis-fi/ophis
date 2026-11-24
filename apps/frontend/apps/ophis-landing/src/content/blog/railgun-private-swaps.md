---
title: "RAILGUN Private Swaps on Ophis: How They Work"
description: "Learn how RAILGUN private swaps work on Ophis, how to fund and use a shielded wallet, and what remains visible on Ethereum, Arbitrum and BNB Chain."
slug: "railgun-private-swaps"
primaryKeyword: "railgun"
author: "Ophis"
pubDate: 2026-11-24
tags: [railgun, privacy, private-swaps, zero-knowledge]
draft: false
cover: ./railgun-private-swaps.cover.jpg
coverAlt: "Ophis emblem with a privacy icon and the Ethereum, Arbitrum and BNB Chain logos."
---

**RAILGUN lets you hold and spend tokens from a shielded balance.** Ophis uses it for private swaps on Ethereum, Arbitrum One and BNB Chain. Your private wallet can authorize a swap without publicly identifying the shielded funds it spent. Deposits, withdrawals and the exchange-pool trade itself remain visible. [Ophis private swap documentation](https://docs.ophis.fi/privacy-pools/)

For the basics of shielded balances and what privacy pools can hide, see [how privacy pools work](/blog/privacy-pools-how-they-work/).

## How does a RAILGUN private swap work?

You move tokens from your public wallet into a RAILGUN pool. This is called **shielding**. The pool holds the assets in smart contracts, and your private wallet uses a **zero-knowledge proof** to show it can spend them without revealing which part of the shielded balance supplied the funds. [RAILGUN overview](https://docs.railgun.org/wiki/learn/overview)

In Ophis, supported Uniswap v3 pools provide the exchange rate and liquidity. A **broadcaster** submits the transaction and pays the network fee using prepaid gas credit. The tokens you receive return to your shielded balance. When you withdraw to a public wallet, that step is called **unshielding**. [Ophis private swap implementation](https://github.com/ophis-fi/ophis/blob/main/apps/railgun/README.md)

## How to make a private swap on Ophis

1. Open the [Ophis swap app](https://swap.ophis.fi/) and select **Private**. Choose Ethereum, Arbitrum One or BNB Chain, then create, restore or unlock your private wallet. Save its recovery phrase offline.
2. Select **Add funds**, connect your public wallet and choose a supported asset. Review and confirm the deposit, then wait until your private balance shows **Spendable**.
3. If needed, top up **Ophis fee credit** in the network’s native currency, ETH or BNB. Use a standard public wallet for the top-up. Once it is final onchain, select **Check top-up** to verify your available credit.
4. Choose your tokens and amount. Select **Review swap**, check the minimum amount you’ll receive, the broadcaster and the fees, then confirm.
5. When you want to move funds out, select **Withdraw to a public wallet** and review the destination and net amount before confirming.

Private balances stay on the network where you deposited them. A route needs available liquidity and a broadcaster. If a swap or withdrawal remains pending, use **Recovery and pending transactions** to check the saved request before trying again. Keep your browser records while a transaction is pending. The recovery phrase alone does not restore every pending record. [Wallet setup and recovery instructions](https://docs.ophis.fi/privacy-pools/#interrupted-transactions)

## What does a private swap cost?

Ophis charges **0.1% of the swap output**. Liquidity and broadcaster costs also apply, and depositing or withdrawing can carry separate charges. Review the minimum received and the fee estimate before confirming. [Ophis private swap fees](https://docs.ophis.fi/fees/#private-swap-costs)

The operator holds prepaid gas credit separately from the tokens in your shielded balance. Top-ups and refunds are public transfers. A submitted transaction can use gas even if it fails. Refunds require an available refund service and enough credit to leave a payout after processing costs. [Funding transaction fees](https://docs.ophis.fi/privacy-pools/#fund-transaction-fees) · [Refunding unused credit](https://docs.ophis.fi/privacy-pools/#refund-unused-fee-credit)

## What stays visible?

| Activity | What can be seen |
| --- | --- |
| Deposits and withdrawals | Public addresses, assets, amounts and timing. |
| Swap execution | The trade in the liquidity pool, its amounts and the Ophis fee. |
| Fee-credit activity | Public transfers and their amounts. The operator can link activity on the same fee-credit account. |
| App access | Ophis and its web gateway provider can see your IP address. |
| Transaction checks | The service that checks the signed transaction before submission receives a copy and may be able to submit it. |

Timing and amounts can still link activity. Paying for certain recovery steps from a public wallet can also create a public link. Ophis private swaps use Uniswap v3 routes outside the public Ophis batch auction, and private submission offers no blanket guarantee against adverse transaction ordering. [Ophis private wallet security](https://docs.ophis.fi/audits/#private-wallet-security) · [How public batch auctions reduce MEV](/blog/mev-protection-batch-auctions/)

## FAQ

### Do I need Private Proofs of Innocence to use Ophis private mode?

The current Ophis wallet and broadcaster do not require RAILGUN’s optional **Private Proofs of Innocence** screening. The pool still verifies that a spend is valid. Other RAILGUN wallets and services may enforce their own screening rules. [Ophis private swap documentation](https://docs.ophis.fi/privacy-pools/) · [RAILGUN’s explanation of PPOI](https://docs.railgun.org/wiki/assurance/private-proofs-of-innocence)

### Does switching to Private shield my public wallet balance?

Switching modes opens a separate private wallet. You move supported assets into its shielded balance using **Add funds**.

### Which networks support Ophis private swaps?

Ophis private mode supports Ethereum, Arbitrum One and BNB Chain. Supported assets and available routes depend on the network. [Private networks and assets](https://docs.ophis.fi/privacy-pools/#networks-and-assets)
