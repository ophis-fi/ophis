---
title: "Solana Bridge: Move Tokens Between Solana and Ethereum"
description: "Learn how to bridge SOL or USDC between Solana and Ethereum, Base or Arbitrum with Ophis, and what to check before sending a cross-chain transfer."
slug: "solana-bridge"
primaryKeyword: "solana bridge"
author: "Ophis"
pubDate: 2026-11-26
tags: [solana, bridging, cross-chain, near-intents]
draft: false
cover: ./solana-bridge.cover.jpg
coverAlt: "Ophis emblem at the centre of a saffron orbit ring, with the Solana and Ethereum logos on opposite nodes joined by a highlighted route."
---

A **Solana bridge** lets you move value between Solana and another blockchain, such as Ethereum, Base or Arbitrum. The Ophis swap app uses **NEAR Intents** for supported cross-chain routes. You can move USDC to another network or change the token along the way, for example by selling SOL on Solana and receiving USDC on Base. The app shows which routes are available for your token and amount. If both tokens are on Solana, you do not need a bridge: [swap on Solana](/swap/solana/) instead. [Ophis networks and bridge routes](https://docs.ophis.fi/networks-assets/#externally-funded-swaps-through-near-intents)

## How does a Solana bridge work?

The bridge takes funds on the source network and arranges delivery on the destination. What arrives depends on the route:

| Bridge design | What you receive |
| --- | --- |
| Lock and mint | A wrapped token that represents assets locked on the original network. |
| Burn and mint | A fresh copy of the issuer’s token on the destination. Circle’s Cross-Chain Transfer Protocol uses this approach for USDC. |
| Cross-chain swap | The token you selected on the destination. NEAR Intents gets competing quotes from market makers and tracks delivery after the source deposit. |

Check the full token and network names on the quote. Several tokens can use the same ticker, and an app or exchange may accept only one version. For USDC, use Circle’s list to verify the token on the destination. [Circle’s bridge documentation](https://developers.circle.com/cctp) · [Circle’s official USDC addresses](https://developers.circle.com/stablecoins/usdc-contract-addresses) · [NEAR Intents cross-chain swap documentation](https://docs.near-intents.org/integration/distribution-channels/1click-api/about-1click-api)

## How to bridge from Solana to Ethereum, Base or Arbitrum

1. In the [Ophis swap app](https://swap.ophis.fi/#/swap), open the token picker under **You sell** and choose a token on Solana. Under **You receive**, choose the asset and network you want. The Solana entry in the network menu opens a swap that stays on Solana.
2. Enter your destination wallet address and a **refund address on Solana**. Double-check both addresses before requesting a quote.
3. Review the exact deposit, minimum received and deadline. Confirm the quote to save the transfer, then send the quoted amount from your Solana wallet to the shown deposit address. Include a memo if the app asks for one. Keep enough SOL to pay the sending fee.
4. Track delivery or refund in the app. Keep the saved transfer and the Solana transaction reference until the transfer is complete.

## How to bridge from Ethereum, Base or Arbitrum to Solana

1. Connect the wallet that holds your funds and choose the token and source network.
2. Select a Solana asset to receive, such as SOL or USDC when available, and enter a Solana address you control.
3. Review the minimum received and costs, then follow your wallet’s prompt. An ERC-20 token such as USDC may need an approval before you sign the order. Selling native ETH can require a network transaction.
4. Follow the status through destination delivery and check your balance on Solana.

For a comparison of these steps with other routes, see the [Ophis crosschain swap guide](/blog/crosschain-swap/).

## How much does a Solana bridge cost and how long does it take?

Compare the **minimum received** for the same starting amount and include any separate network fees. The route quote reflects the swap and bridge costs. Your wallet may show an additional network fee for sending funds or approving a token. Delivery time depends on source confirmations and the route. Use the status in the app to decide when the transfer has completed. [Ophis bridge costs](https://docs.ophis.fi/fees/#bridge-and-conversion-routes)

## FAQ

### Can I bridge SOL to Ethereum or Base?

A cross-chain swap can sell SOL on Solana and deliver an available asset such as ETH or USDC on the selected destination. Check the quote to see exactly what arrives.

### Do I need a bridge to swap two Solana tokens?

No. A swap that starts and ends on Solana does not cross a bridge. Ophis swaps SOL and SPL tokens natively on Solana with a Solana wallet. [Swap on Solana](/swap/solana/)

### Do I need SOL to receive tokens on Solana?

You can receive tokens at a Solana address. Your wallet usually needs a small SOL balance when you later send or swap those tokens on Solana. [Solana network fees](https://solana.com/docs/core/fees)

### What happens if a Solana bridge transfer fails?

Check the saved transfer before sending again. For the externally funded NEAR Intents flow, a refund goes to the source-chain refund address when the provider can return the funds. Refunds can take time and incur costs. If the status is unclear, use the app’s recovery flow with the transaction reference. [Ophis delivery and recovery instructions](https://docs.ophis.fi/networks-assets/#externally-funded-swaps-through-near-intents)
