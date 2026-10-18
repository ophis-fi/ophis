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
ophis connect                      # link your wallet app: scan the QR code with it
ophis quote 5 USDC ETH             # see the price; nothing is signed
ophis swap 5 USDC ETH              # say yes here, then approve in your wallet
ophis bridge 25 USDC to arbitrum   # move 25 USDC from Base to Arbitrum
```

## Choose the chain

Everything happens on Base unless you name a chain. Name it in plain words:

```sh
ophis swap 5 USDC ETH on arbitrum            # swap on Arbitrum
ophis swap 5 USDC ETH to arbitrum            # swap on Base, get the ETH on Arbitrum
ophis bridge 25 USDC from arbitrum to base   # move USDC from Arbitrum to Base
ophis status <order id> on arbitrum          # follow an order placed on Arbitrum
ophis chains                                 # every chain, and the name to type
```

`-c <chain>` and `--to-chain <chain>` work the same as `on` and `to`.

## Commands

| Command | What it does |
| --- | --- |
| `ophis connect` | Link your wallet app with a QR code. |
| `ophis quote <amount> <token> <token>` | See the price. Nothing is signed. |
| `ophis swap <amount> <token> <token>` | Swap: say yes in the terminal, then approve in your wallet. |
| `ophis bridge <amount> <token> to <chain>` | Move a token to another chain (through Across). |
| `ophis status <order id>` | See where an order is, and a bridge's progress. |
| `ophis recover [token]` | Get back tokens a bridge left behind in your CoW Shed. |
| `ophis wallet` / `ophis disconnect` | Show or unlink your wallet. |
| `ophis chains` | Every chain you can trade on. |

Options: `-s, --slippage <percent>` (how far the price may move, default 0.5), `-y, --yes` (skip the question in the
terminal; your wallet still asks), `--to-token <token>` (with bridge: get a different token on arrival),
`--ref <code>`, `--rpc <url>`.

## Chains

Arbitrum One, Arc, Avalanche, Base, BNB Chain, Ethereum, Gnosis, Ink, Linea, Optimism, Plasma, Polygon, Robinhood
Chain, Unichain, and the Sepolia testnet. Bridges can start from Ethereum, Arbitrum or Base. In the terminal, each
chain shows with a dot in its brand colour.

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
