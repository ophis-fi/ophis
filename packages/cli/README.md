# Ophis CLI

Swap and bridge on [Ophis](https://ophis.fi) from your terminal. Your keys never leave your wallet: the CLI pairs with
your wallet app (MetaMask, Rabby, Rainbow, Trust, Ledger Wallet...) through WalletConnect, and you approve every step
there.

## Install

Requires Node.js 20 or later.

```sh
npm install -g @ophis/cli
ophis help
```

Or run it once without installing: `npx @ophis/cli help`.

## Quick start

```sh
ophis connect                                    # scan the QR code with your wallet app
ophis quote 100 USDC ETH                         # see the price; nothing is signed
ophis swap 0.05 ETH USDC -c arbitrum             # confirm here, then approve in your wallet
ophis bridge 25 USDC -c base --to-chain arbitrum # move a token to another chain
ophis status <order id> -c base                  # follow an order
```

## Commands

| Command | What it does |
| --- | --- |
| `ophis connect` | Pair your wallet app with a QR code. |
| `ophis quote <amount> <token> <token>` | Show the price. Nothing is signed. |
| `ophis swap <amount> <token> <token>` | Swap: confirm in the terminal, then approve in your wallet. |
| `ophis bridge <amount> <token> --to-chain <chain>` | Bridge a token to another chain (through Across). |
| `ophis status <order id>` | Check an order, and a bridge's progress. |
| `ophis recover [token]` | Move what a bridge left in your CoW Shed back to your wallet. |
| `ophis wallet` / `ophis disconnect` | Show or end the wallet connection. |
| `ophis chains` | List the chains you can trade on. |

Options: `-c, --chain <name>` (default `base`), `--to-chain <name>`, `--to-token <token>`, `-s, --slippage <pct>`
(default 0.5), `-y, --yes`, `--ref <code>`, `--rpc <url>`.

## Chains

Ethereum, Base, Arbitrum One, Optimism, Polygon, BNB Chain, Gnosis, Avalanche, Linea, Ink, Unichain, Plasma, Robinhood
Chain, Arc, and the Sepolia testnet. Bridges can start from Ethereum, Arbitrum or Base.

## How it keeps you safe

- **Keys stay in your wallet.** The CLI only asks your wallet to sign, and checks what it asks for first: the order,
  its recipient and amounts, and for a bridge the bridge step and its deadlines.
- **Tokens by name come from trusted lists.** The Ophis token list first, then the public lists swap.ophis.fi also
  offers. The exact contract address is always shown, a token outside the Ophis list is flagged, and a name that could
  mean two tokens is refused: use the address instead.
- **Fees are shown before you confirm.** Ophis takes 0.01% of the trade, plus a share of the price improvement on
  some chains; a bridge also pays the Across relay fee.
- **Nothing runs in the background.** Your wallet connection and bridge records live in `~/.ophis` (or `OPHIS_HOME`).

## License

GPL-3.0-or-later
