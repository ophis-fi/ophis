---
title: "Swap on Arc: Ophis Is Live on Circle's Stablecoin Blockchain"
description: "Ophis is now live on Arc, Circle's stablecoin blockchain. Swap USDC, EURC and cirBTC, bring USDC over from five networks and trade with MEV protection."
pubDate: 2026-09-27
updatedDate: 2026-09-30
author: Ophis
tags: [arc, circle, usdc, stablecoins, dex-aggregator, swaps, cctp]
draft: false
cover: ./swap-on-arc.cover.webp
coverAlt: "Three tokens cross a white ceramic arch toward an open wallet."
---

**Ophis is now live on Arc, the stablecoin blockchain built by Circle. You can swap tokens on Arc, starting with USDC, EURC and cirBTC, bring USDC over from Ethereum, Base, Arbitrum, Optimism or Unichain, and trade with the protections Ophis offers everywhere: gasless settlement, MEV protection and a minimum you sign yourself.**

Ophis is a member of the [Circle Alliance Program](https://www.circle.com/alliance-program), as shown in [Circle's member directory](https://partners.circle.com/partner/ophis).

On most blockchains, your first errand is buying the network's own coin to pay fees. Arc skips that step. Fees are paid in USDC, the digital dollar many people already hold, so the money you trade with also covers the network.

Ophis went live on Arc on September 24, 2026, eight days after Arc's public mainnet launch.

**[Check an Arc swap quote on Ophis](https://swap.ophis.fi/#/5042/swap).**

## What does Ophis on Arc mean for you?

### Circle's blockchain, with Ophis protections

Ophis is an intent-based DEX aggregator. You set the trade you want, and Ophis's [solver](https://ophis.fi/learn/what-is-a-solver/) checks several routing paths through Uniswap pools and other on-chain liquidity on Arc. Ophis currently operates this solver itself. You get one quote instead of checking venues one by one.

Every order includes the minimum amount you agree to receive, and it cannot settle below that. Orders are also MEV-protected: they settle in batch auctions designed to reduce exposure to front-running and sandwich attacks. Here is [how batch auctions work](https://ophis.fi/blog/mev-protection-batch-auctions/).

### What does an Arc swap cost?

You sign an order instead of paying Arc gas to submit the swap yourself. Ophis's solver pays the network gas to settle it; the quoted trade accounts for settlement costs. Arc now follows the standard Ophis market-order policy: a 0.01% base plus 80% of reference-quote improvement capped at 99 bps for volatile pairs, or 50% capped at 20 bps for recognized stablecoin pairs such as USDC/EURC. Check the current quote and signed fee details before trading; the [fee documentation](https://docs.ophis.fi/fees/) explains the fee schedule. If a token needs approval first, that separate wallet transaction costs USDC gas on Arc. The [gasless swaps guide](https://ophis.fi/blog/gasless-swaps-how-intents-work/) explains the distinction.

For one real example, the first Ophis swap on Arc, on September 24, 2026, sold 2 USDC for 1.740907 EURC. The solver's on-chain transaction used about 0.0066 USDC in network gas. That figure is the network gas for this transaction, not the total cost of every swap. [See the transaction on Arc's explorer](https://explorer.arc.io/tx/0xba2f98b61df1c265f1f3d5e795293085523d2146c664bd2a5e8670c137e0685e).

### Bridge and swap in one place

Getting started on a new network usually means juggling a bridge, an exchange and a block explorer. With Ophis, you can bring USDC to Arc and then trade it from the same swap box. The bridge and swap are separate steps.

### A fourth Ophis-operated network

Arc joins Optimism, Unichain and Robinhood Chain as a network where Ophis runs its own trading infrastructure. The [supported chains page](https://ophis.fi/supported-chains/) lists every network Ophis covers.

## What is Arc?

Arc is an open, EVM-compatible Layer-1 blockchain built by Circle, the company that issues the USDC stablecoin. It is designed for payments, currency exchange and tokenized assets, and it uses USDC to pay network fees. Arc's public mainnet launched on September 16, 2026.

EVM-compatible means Arc works with the same kind of wallets and apps as Ethereum. What sets it apart is its focus on money:

- **Fees in dollars.** Network fees are paid in USDC instead of a volatile token, and Arc is [designed](https://docs.arc.io/arc/references/gas-and-fees) to keep a simple token transfer at about $0.001.
- **Fast, final blocks.** Arc confirms transactions in under a second, and once confirmed, they are final. An Ophis order may take longer to fill, and a crosschain transfer can take several minutes.
- **Institutional validators.** Arc launched with Circle and eleven other founding validators, including BlackRock, Visa, Mastercard and DTCC, according to [Circle's validator announcement](https://www.circle.com/pressroom/circle-announces-founding-validator-cohort-and-major-integrations-for-arc-ahead-of-september-16-mainnet-launch).

Before mainnet, Arc's test network processed more than 700 million transactions in under a year, according to [Circle](https://www.circle.com/pressroom/circle-launches-arc-mainnet-an-economic-operating-system-for-the-internet).

| Detail | Arc mainnet |
| --- | --- |
| Built by | Circle |
| Public launch | September 16, 2026 |
| Network fees paid in | USDC |
| Finality | Under one second |
| Chain ID | 5042 |
| Official explorer | [explorer.arc.io](https://explorer.arc.io) |

## What can you do with Ophis on Arc?

### Swap between dollar and euro stablecoins

[EURC](https://www.circle.com/eurc) is Circle's euro-backed stablecoin. Eligible holders can redeem it 1:1 for euros through Circle, subject to [Circle's terms](https://www.circle.com/legal/eurc-terms). An Arc swap exchanges USDC for EURC at the quoted market rate in your wallet; it does not send euros to a bank account. Our [stablecoin swaps overview](https://ophis.fi/stablecoin-swaps/) explains how intent-based stablecoin swaps work.

### Check quotes for bitcoin, ether, gold and stock tokens

The Ophis token list for Arc holds more than 40 tokens, including:

- **cirBTC**, [Circle Wrapped Bitcoin](https://www.circle.com/cirbtc), backed 1:1 by bitcoin, with reserves you can check on-chain.
- **WETH**, wrapped ether.
- **XAUM**, a gold-backed token from Matrixdock.
- **Tokenized stocks from Ondo** for eligible traders, such as CRCLon, which tracks Circle Internet Group's shares. Our [stock tokens guide](https://ophis.fi/blog/stock-tokens-tokenized-stocks/) explains how they work.

A token's presence on the list does not guarantee an executable quote. Check the live price and minimum received before signing; tokenized stocks also have [eligibility restrictions](https://ondo.finance/ondo-stocks).

### Bring USDC and more to Arc

In the Ophis swap box, choose USDC on Ethereum, Base, Arbitrum, Optimism or Unichain as the token you send, and USDC on Arc as the token you receive. Ophis moves it with Circle's Cross-Chain Transfer Protocol (CCTP): your USDC is burned on the source network and native USDC is issued to you on Arc, so you never hold a wrapped copy. The same route takes you back when you want to leave Arc.

Ophis also lists Circle-based bridge routes for EURC between Ethereum, Base and Arc, and for cirBTC between Ethereum and Arc. Check the current route, fee and wallet eligibility in the app. If you hold WBTC on Ethereum, the app can first swap it for cirBTC and then bridge it to Arc. Those are separate steps with separate costs, each confirmed in the same box.

## How to swap on Arc with Ophis

1. **Open Ophis on Arc.** Go to [swap.ophis.fi/#/5042/swap](https://swap.ophis.fi/#/5042/swap). The number 5042 is Arc's chain ID, so the app opens on the right network.
2. **Connect your wallet.** Arc works with wallets built for Ethereum apps. If yours needs the network details, add Arc with the [official settings](https://docs.arc.io/arc/references/connect-to-arc).
3. **Add USDC on Arc.** USDC is what you trade and what pays network fees. If your USDC is on another network, bring it over first, as shown below.
4. **Choose your tokens and amount.**
5. **Review the quote.** You see the expected amount, the minimum you will receive and the fee.
6. **Approve if needed, then sign.** If your token allowance is insufficient, approve it with an on-chain wallet transaction paid in USDC on Arc. Then sign the swap order; signing the order itself does not use gas.
7. **Your order settles.** Ophis's solver checks available routing paths to fill it, and you can follow your Arc trades in the [Ophis explorer](https://explorer.ophis.fi/arc).

## How to bridge USDC to Arc

1. **Choose your USDC.** In the swap box, select USDC on Ethereum, Base, Arbitrum, Optimism or Unichain as the token to send.
2. **Choose USDC on Arc** as the token to receive.
3. **Review the transfer.** The swap box shows Circle's bridge fee and the minimum you will receive on Arc. Ophis adds no fee to this direct USDC bridge; source-network gas is separate.
4. **Approve if needed and confirm in your wallet.** Approval and the source transfer each use ETH for gas. This CCTP route currently supports personal wallets and delivers to the same wallet address on Arc.
5. **Receive native USDC on Arc.** Circle burns the USDC on the source network and normally forwards native USDC to your wallet on Arc without requiring an existing Arc balance. If automatic delivery stalls, a manual claim requires USDC on Arc for gas. Standard transfers can take several minutes.

For more on moving assets between networks, read the [crosschain swap guide](https://ophis.fi/blog/crosschain-swap/).

## FAQ

### What is the Arc blockchain?

Arc is an open Layer-1 blockchain built by Circle, the issuer of USDC. It uses USDC for network fees, confirms transactions in under a second and is designed for payments, currency exchange and tokenized assets. Its public mainnet launched on September 16, 2026.

### Is Ophis live on Arc?

Yes. Ophis went live on Arc on September 24, 2026. You can swap tokens on Arc and move USDC between Arc and Ethereum, Base, Arbitrum, Optimism or Unichain in the Ophis swap app.

### Do I need a separate token to pay fees on Arc?

No separate gas token is needed. Arc charges network fees in USDC. A solver pays to settle your signed swap order, while any approval you make yourself uses USDC gas.

### How do I bridge USDC to Arc?

In the Ophis swap box, choose USDC on Ethereum, Base, Arbitrum, Optimism or Unichain as the token to send and USDC on Arc as the token to receive. Circle's CCTP burns the USDC on the source network and normally forwards native USDC to the same personal wallet on Arc. Review the bridge fee and source gas before confirming.

### How much does it cost to swap on Arc with Ophis?

Ophis charges a 0.01% base on Arc plus capped reference-quote improvement: 80% capped at 99 bps for volatile pairs, or 50% capped at 20 bps for recognized stablecoin pairs. The quote reflects settlement costs; a token approval, if needed, uses USDC gas separately. Check the current quote and signed fee details, and see the [Arc fee documentation](https://docs.ophis.fi/fees/).

### What is Arc's chain ID?

Arc mainnet uses chain ID 5042. Its official RPC address is `https://rpc.mainnet.arc.io` and its official block explorer is explorer.arc.io.

### What is Ophis's relationship with Circle?

Ophis is an independent project and a member of the Circle Alliance Program. It supports Arc and uses Circle's public transfer protocol; it is not a Circle product.

## Start trading on Arc

Arc gives stablecoins a network of their own, and Ophis gives you a simple way to trade on it. Bring your USDC over, pick a pair and sign from your own wallet.

**[Open Ophis on Arc](https://swap.ophis.fi/#/5042/swap).**
