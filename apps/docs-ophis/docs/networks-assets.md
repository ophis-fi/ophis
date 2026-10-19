---
id: networks-assets
title: Networks, bridges & assets
description: Find supported networks, bridge routes, wallet requirements and token information for Ophis swaps.
sidebar_label: Networks & assets
---

# Networks, bridges & assets

Use the swap app's token pickers to choose a network, asset and route.

## Network coverage {/* #app-parser-and-sdk-coverage */}

| Surface | Coverage |
| --- | --- |
| Swap app and CLI | 15 EVM networks, including the Sepolia testnet; see [the network list](/getting-started#supported-networks) |
| SDK v0.4.3 and hosted MCP | 14 EVM mainnets, including Arc (5042), with chain-specific orderbook and signing-domain helpers |
| Vault-order builder | `@ophis/safe-swap` v0.1.7 uses SDK v0.4.4 for ERC-20 presigned orders on 14 EVM mainnets, including Arc |
| Intent parser | 14 chain slugs, including `arc` |
| Standalone app through NEAR Intents | Bitcoin, Solana, Monad, Hyperliquid (Hypercore), X Layer, Sui, Tron, Starknet, Zcash |

| Orderbook operator | Networks |
| --- | --- |
| Ophis | Optimism, Unichain, Robinhood Chain, Arc |
| CoW Protocol | The other ten mainnets |

Use the SDK's chain-specific orderbook and signing-domain helpers for Arc orders.

| Arc setting | Value |
| --- | --- |
| Chain ID | 5042 |
| Orderbook | `https://arc-mainnet.ophis.fi` |
| EIP-712 settlement | `0x78799F98276efba1EdeeD32eae03a3fd8Cdfec3A` |
| Gas currency | USDC |
| Native balance decimals | 18 |
| ERC-20 USDC decimals | 6 |

Arc's native and ERC-20 USDC interfaces access the same balance. Use the ERC-20 interface for token amounts and bridging. See [Arc fees](/fees#arc-price-improvement-policy).

## NEAR Intents swaps {/* #externally-funded-swaps-through-near-intents */}

The standalone app accepts external-source deposits through NEAR Intents and tracks destination delivery or refunds.

| Route requirement | Details |
| --- | --- |
| Additional sources and destinations | Bitcoin, Solana, Monad, Hyperliquid (Hypercore), X Layer, Sui, Tron, Starknet, Zcash |
| EVM receiving networks | Ethereum, Base, Arbitrum, Optimism, Polygon, BNB, Avalanche, Gnosis, Plasma, Robinhood Chain |
| Source funding | Quoted deposit amount, deadline and any required memo |
| Refund address | Address on the source chain |
| Hyperliquid (Hypercore) | Hypercore spot balances; exact-input routes with a source-chain refund address |
| Zcash | Mainnet transparent t1/t3 address |
| Network fees | Source-chain gas or transfer fees |

<Steps>

1. **Select your assets.** Choose the source in **You sell** and the destination in **You receive**.
2. **Review the quote.** Check the exact deposit, minimum receive amount, destination address, refund address and deadline.
3. **Fund the transfer.** Confirm the quote to save the transfer record, then send the quoted deposit from your source wallet with any required memo.
4. **Track delivery.** Keep the transfer record until delivery or refund completes; use the app's transaction-reference recovery to resume tracking.

</Steps>

:::tip[Check addresses before funding]

Use a refund address on the source chain. For Zcash, use a mainnet transparent t1/t3 address. Copy the deposit amount and memo from the saved quote.

:::

## Circle bridges {/* #arc-and-circle-bridges */}

The swap form bridges assets through Circle between Arc, Ethereum, Base, Arbitrum, Optimism and Unichain. USDC uses CCTP. EURC, cirBTC and WETH use Circle's token service where both networks have a supported mapping.

| Requirement | Details |
| --- | --- |
| Network set | Arc, Ethereum, Base, Arbitrum, Optimism, Unichain |
| Swap type | Exact input |
| Wallet | Personal EOA without smart-account code |
| Recipient | Connected wallet |
| Gas | Required for approvals, conversion and bridge transactions |
| Recovery | Keep the pending transfer record for delayed attestation or minting |

**Ethereum WBTC to Arc cirBTC** takes two steps: convert WBTC on Ethereum, then bridge cirBTC to Arc.

Check the quoted fees, minimum receive amount and destination gas requirements before signing. Follow the transfer until destination delivery completes.

## Across bridges

The app also uses Across for supported cross-chain routes.

| App source route | Destination example |
| --- | --- |
| Optimism | Base |
| Polygon USDC | Robinhood Chain USDG |

For terminal swaps, use the [CLI's bridge source list](/cli#bridge-tokens).

## Tokenized assets {/* #tokenized-asset-labels */}

| Provider label | Source |
| --- | --- |
| Ondo, xStocks, Coinbase, bStocks, Reality | Configured token-list metadata for the chain and contract |
| bStocks on BNB | Configured CoinGecko lists and naming conventions |
| Reality/rStock on Arbitrum | Configured CoinGecko lists and naming conventions |
| Robinhood Stock Tokens | Canonical-registry and corporate-action multiplier checks |

Check the token contract, issuer disclosures and trading restrictions before swapping. Ophis displays Robinhood Stock Token restrictions and multipliers in the swap form.

## Ethereum OTC trading {/* #otc-is-a-separate-ethereum-flow */}

The OTC desk lets you create, fill and cancel public orders through immutable escrow on Ethereum.

| Requirement | Details |
| --- | --- |
| Assets | WETH, USDC, DAI |
| Wallet | Standard EOA without contract or delegated code |
| Fill type | All-or-nothing |
| Transactions | Create, fill, cancel and approvals cost gas |
| Expiry | No automatic onchain order expiry |

:::warning[Cancel an open OTC order]

OTC orders stay open until filled or cancelled. A pending fill can race your cancellation; check the transaction result and order status.

:::

## Next

<Cards>
<Card icon="receipt" title="Fees" href="/fees">Review swap and bridge costs.</Card>
<Card icon="terminal" title="Ophis CLI" href="/cli">Choose a network from your terminal.</Card>
<Card icon="shield-check" title="Security and audits" href="/audits">Review settlement and wallet custody.</Card>
</Cards>
