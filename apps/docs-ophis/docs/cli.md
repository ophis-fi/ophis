---
id: cli
title: Ophis CLI
description: Quote, swap and bridge from your terminal with approvals in your wallet.
sidebar_label: Ophis CLI
---

# Ophis CLI

Use the Ophis CLI to check prices, swap tokens and bridge between networks by typing commands in your terminal.

## Before you start

| Requirement | Details |
| --- | --- |
| Computer | Node.js 20 or later; npm comes with Node.js |
| Phone wallet | MetaMask, Rabby, Trust Wallet, Rainbow or Ledger Wallet |

## Install the CLI {/* #install */}

<Steps>

1. **Install the package.** Run this command in your terminal:

   ```sh
   npm install -g @ophis/cli
   ```

2. **Check the version.** A version number confirms the installation:

   ```sh
   ophis --version
   ```

</Steps>

Run the install command again to update. To run the CLI once without installing:

```sh
npx @ophis/cli help
```

## Connect your wallet

<Steps>

1. **Start the connection.** Run:

   ```sh
   ophis connect
   ```

2. **Scan with your wallet.** Open its WalletConnect scanner and scan the QR code, or paste the pairing link into the wallet.
3. **Approve the connection.** Your wallet handles signing requests and keeps your keys.

</Steps>

| Wallet | Where to scan |
| --- | --- |
| MetaMask | **Scan**, in the account menu or at the top right |
| Rabby | **Settings > WalletConnect** |
| Trust Wallet | **Scan QR code**, at the top right |
| Rainbow | Scan icon on the home screen |
| Ledger Wallet | Open an account, then its **WalletConnect** icon |

:::tip[Use the wallet scanner]

Scan the code inside your wallet app. Keep the wallet open while the CLI waits for a response; in Ledger Wallet, stay on the WalletConnect screen.

:::

## Quote and swap {/* #quote-swap-bridge */}

<Steps>

1. **Check the price.** Request a quote:

   ```sh
   ophis quote 5 USDC ETH
   ```

2. **Start the swap.** Sell USDC for ETH:

   ```sh
   ophis swap 5 USDC ETH
   ```

3. **Review and approve.** Confirm the amounts in the terminal, then approve in your wallet. Approve token spending if requested, then sign the order. Each approval covers the amount needed. Selling ETH uses WETH, its token form, and requires wrapping if needed.

</Steps>

## Bridge tokens

Move USDC from Base to Arbitrum through Across:

```sh
ophis bridge 25 USDC to arbitrum
```

| CLI bridge setting | Networks |
| --- | --- |
| Supported sources | Ethereum, Arbitrum, Base |
| Default source | Base |

Confirm the route in the terminal and approve in your wallet. Use `ophis status <order id>` to follow the transfer.

## Choose the chain

The default network is **Base**. Add a chain name to change the source or destination.

| Words | Meaning | Example |
| --- | --- | --- |
| `on arbitrum` | Trade on Arbitrum | `ophis swap 5 USDC ETH on arbitrum` |
| `to arbitrum` | Trade on Base and receive on Arbitrum | `ophis swap 5 USDC ETH to arbitrum` |
| `from arbitrum to base` | Bridge from Arbitrum to Base | `ophis bridge 25 USDC from arbitrum to base` |
| `-c <chain>` | Same as `on` | Select the source chain |
| `--to-chain <chain>` | Same as `to` | Select the destination chain |

For an Arbitrum order, use `ophis status <order id> on arbitrum`.

| Network list | Chains |
| --- | --- |
| Mainnets | Arbitrum One, Arc, Avalanche, Base, BNB Chain, Ethereum, Gnosis, Ink, Linea, Optimism, Plasma, Polygon, Robinhood Chain, Unichain |
| Testnet | Sepolia |
| Total | 15 |

Run `ophis chains` to see the names to type.

## Swap fees {/* #fees */}

| Charge | Amount |
| --- | --- |
| Ophis base | 0.01%; 0.01 USDC on a 100 USDC swap |
| Price improvement | Share and cap shown on every quote and confirmation |
| CoW Protocol volume fee | 0.02%, or 0.003% between stablecoins |
| Base plus CoW volume fee on a regular swap | 0.03% |
| CoW-hosted networks | 10, including Base |
| Ophis-operated networks | Optimism, Unichain, Robinhood Chain, Arc; no upstream fee |
| Across bridge fee | Included in the displayed amounts |

You receive at least the amount shown as **At least**. See [Fees](/fees) for improvement capture and upstream fee details.

Signing an order is free. Token approvals, wrapping ETH and `ophis recover` require network fees. Each approval covers the amount needed for that swap.

## Wallet checks {/* #safety */}

<Cards>
<Card icon="key-round" title="Wallet signing">Your wallet holds your keys and approves each order.</Card>
<Card icon="shield-check" title="Order validation">The CLI checks amounts, recipient, chain and bridge steps before requesting approval.</Card>
<Card icon="search" title="Token addresses">The CLI displays each token's contract address for you to check.</Card>
</Cards>

The CLI checks the Ophis token list first, then public lists from swap.ophis.fi. It flags tokens outside the Ophis list and rejects ambiguous names. Before approving, match the wallet's amounts and token addresses to the terminal.

## Connection and tokens {/* #troubleshooting */}

<details>
<summary>The wallet did not answer</summary>

Keep the wallet open, then run `ophis connect` again if needed. Some wallets, including Rabby, drop the connection on restart. Use `ophis wallet` to check the session.

</details>

<details>
<summary>Connect another network</summary>

Add the network in your wallet's settings. Run `ophis connect` and approve the connection again, then check the chain with `ophis wallet`.

</details>

<details>
<summary>Use ETH on another chain</summary>

| Network | Token to request |
| --- | --- |
| Arc, Polygon, Gnosis | ETH resolves to WETH automatically |
| Avalanche, Plasma | WETH |

```sh
ophis quote 5 USDC WETH on avalanche
ophis quote 5 USDC WETH on plasma
```

</details>

<details>
<summary>Use the dollar token on Robinhood Chain</summary>

Use **USDG** on Robinhood Chain.

```sh
ophis quote 5 USDG ETH on robinhood
```

</details>

## Command reference {/* #all-commands */}

Replace the angle-bracket placeholders with your values. In a quote or swap, the first token is sold and the second is received.

| Command | Action |
| --- | --- |
| `ophis connect` | Link your wallet with a QR code or pairing link |
| `ophis quote <amount> <token> <token>` | Check the price |
| `ophis swap <amount> <token> <token>` | Confirm a swap and approve in your wallet |
| `ophis bridge <amount> <token> to <chain>` | Move tokens through Across |
| `ophis status <order id>` | Track an order or bridge |
| `ophis wallet` | Show your wallet and connected chains |
| `ophis recover [token]` | Recover tokens left by a bridge; use `ophis recover USDC on base` to look for an older transfer |
| `ophis disconnect` | Unlink your wallet |
| `ophis chains` | List networks and their command names |
| `ophis help` | Show commands and options |

## Next

<Cards>
<Card icon="receipt" title="Fees" href="/fees">Review the full swap fee schedule.</Card>
<Card icon="globe" title="Networks and assets" href="/networks-assets">Check app routes and bridge requirements.</Card>
</Cards>
