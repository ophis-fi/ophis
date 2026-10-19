---
id: cli
title: Ophis CLI
description: Quote, swap and bridge from your terminal, with every approval in your own wallet.
sidebar_label: Ophis CLI
---

# Ophis CLI

## What it is

The Ophis CLI lets you check prices, swap tokens and move them between networks
from your terminal. CLI means command-line interface: you type commands instead
of using the website. A terminal is the app where you enter those commands.
Your keys stay in your wallet, where you approve each step.

You need a computer with **Node.js 20 or later** and a wallet app on your phone:
**MetaMask, Rabby, Trust Wallet, Rainbow or Ledger Wallet**.

## Install

In your terminal, install the CLI with npm, which comes with Node.js:

```sh
npm install -g @ophis/cli
```

Check it worked by running:

```sh
ophis --version
```

If it prints a version number, the CLI is installed.

Run the install command again to update it. To run it once without installing:

```sh
npx @ophis/cli help
```

## Connect your wallet

```sh
ophis connect
```

This shows a QR code. Scan it with your wallet app's own **WalletConnect
scanner**, not your phone's Camera app. WalletConnect links the CLI to your
wallet so it can ask you to approve a trade.

| Wallet | Where to scan |
| --- | --- |
| MetaMask | **Scan**, in the account menu or at the top right. |
| Rabby | **Settings > WalletConnect**. |
| Trust Wallet | **Scan QR code**, at the top right. |
| Rainbow | The scan icon on the home screen. |
| Ledger Wallet | Open an account, then its **WalletConnect** icon. |

You can paste the pairing link into the wallet instead. Your keys never leave
your wallet.

## Quote, swap, bridge

Check the price first. Nothing is signed:

```sh
ophis quote 5 USDC ETH
```

To swap 5 USDC for ETH:

```sh
ophis swap 5 USDC ETH
```

Confirm in the terminal, then approve in your wallet. Usually this takes one
free signature. If your wallet has not yet allowed Ophis to spend that amount of
the token, it first asks for an approval, which costs a small network fee. The
CLI approves only the amount each swap needs, so a later swap can ask again. Selling ETH may need a wrap,
which turns ETH into WETH, the token form used for the swap.

A bridge moves tokens to another network. This moves 25 USDC from Base to
Arbitrum through Across, the bridge service:

```sh
ophis bridge 25 USDC to arbitrum
```

Bridges can start from **Ethereum, Arbitrum or Base**.

## Choose the chain

A chain is a blockchain network. Everything runs on **Base** unless you name
a chain in plain words:

| Words | Meaning | Example |
| --- | --- | --- |
| `on arbitrum` | Trade on Arbitrum. | `ophis swap 5 USDC ETH on arbitrum` |
| `to arbitrum` | Trade on Base and receive on Arbitrum, swapping and bridging in one go. | `ophis swap 5 USDC ETH to arbitrum` |
| `from arbitrum to base` | Bridge from Arbitrum to Base. | `ophis bridge 25 USDC from arbitrum to base` |

`-c <chain>` and `--to-chain <chain>` do the same as `on` and `to`.
For an order placed on Arbitrum, use `ophis status <order id> on arbitrum`.

Run `ophis chains` to see all 15 chains and the names to type: **Arbitrum One,
Arc, Avalanche, Base, BNB Chain, Ethereum, Gnosis, Ink, Linea, Optimism, Plasma,
Polygon, Robinhood Chain, Unichain, and the Sepolia testnet**. Sepolia is a
network for testing. Each chain appears in the terminal with its brand colour.

## Fees

Ophis charges **0.01%** of the trade: on a **100 USDC** swap, this fee is
**0.01 USDC**. When a trade fills at a better price than the quote, Ophis keeps
part of the extra, and the exact share and cap appear on every quote and
confirmation. Fees are shown before you confirm.

On the 10 networks where CoW Protocol runs the order book, Base (the default)
among them, CoW Protocol adds its own fee: 0.02% of the trade (0.003% between
stablecoins), so 0.03% in total on a regular swap. The networks Ophis runs
itself (Optimism, Unichain, Robinhood Chain and Arc) have no extra fee. Either
way, you receive at least the amount the CLI shows as **At least**. See
[Fees & rebates](./fees.md) for the details.

Across is the bridge service; its fee is already included in the amounts shown.

Signing an order costs nothing. Network fees only apply to a token approval
(the CLI approves only what each swap needs, so you may approve again later), to wrapping ETH into WETH before selling it, and to `ophis recover`,
which sends a transaction. Wrapping turns ETH into WETH, the token form used
for swaps.

## Safety

- **Keys stay in your wallet.** The CLI asks the wallet to sign.
- **Every order is checked before the wallet is asked.** The CLI checks the
  amounts, recipient, chain and, for a bridge, the bridge step.
- **Token names are checked against lists.** The CLI uses the Ophis list first,
  then the public lists offered by swap.ophis.fi. It always shows the exact
  contract address, which identifies the token on that chain. Tokens outside
  the Ophis list are flagged. A name that could mean two tokens is refused.
- **Before approving**, check that the amounts and token addresses in your
  wallet match what the terminal shows.

## Troubleshooting

### The phone's Camera app cannot open the code

Run `ophis connect` to show a new code, then use the wallet's own WalletConnect
scanner. See
[Connect your wallet](#connect-your-wallet) for where to find it.

### "Your wallet did not answer"

Open your wallet app and keep it open. In Ledger Wallet, stay on its
WalletConnect screen. If it still does not answer, run `ophis connect` again.
Some wallets, such as Rabby, drop the connection when they restart.
Run `ophis wallet` to check your connection.

### A chain is missing in `ophis wallet`

Add the network in your wallet app's network list or settings, then run
`ophis connect` again and approve it in your wallet. Run `ophis wallet` to
check that the chain appears.

### ETH on a chain whose own coin is not ETH

On Arc, Polygon and Gnosis, asking for ETH uses that chain's WETH automatically.
On Avalanche and Plasma, ask for **WETH**:

```sh
ophis quote 5 USDC WETH on avalanche
ophis quote 5 USDC WETH on plasma
```

### The dollar token on Robinhood Chain

Use **USDG** on Robinhood Chain.

```sh
ophis quote 5 USDG ETH on robinhood
```

## All commands

Replace the parts in angle brackets with your amount, tokens, chain or order ID.
The first token in a quote or swap is the one you sell; the second is the one
you receive.

| Command | What it does |
| --- | --- |
| `ophis connect` | Link your wallet with a QR code or pairing link. |
| `ophis quote <amount> <token> <token>` | See the price. Nothing is signed. |
| `ophis swap <amount> <token> <token>` | Confirm in the terminal, then approve in your wallet. |
| `ophis bridge <amount> <token> to <chain>` | Move a token to another chain through Across. |
| `ophis status <order id>` | See where an order is and follow a bridge's progress. |
| `ophis wallet` | Show your wallet and the chains it shares. |
| `ophis recover [token]` | Get back tokens a bridge left behind. Name the token, for example `ophis recover USDC on base`, to look for one from a very old bridge. |
| `ophis disconnect` | Unlink your wallet. |
| `ophis chains` | List the chains and the names to type. |
| `ophis help` | Show commands and options. |
