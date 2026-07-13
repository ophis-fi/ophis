---
name: ophis
description: MEV-protected same-chain token swaps via Ophis (CoW Protocol) using the MetaMask Agent Wallet. Use when the user wants to swap one ERC-20 for another ON THE SAME CHAIN with best execution — no sandwiching/front-running, price improvement (surplus) returned to the trader, and gasless settlement. The MetaMask wallet signs the CoW order directly (EIP-712 via `mm wallet sign-typed-data`) and sends the ERC-20 approval via `mm wallet send-transaction`; the order is submitted to the Ophis/CoW orderbook. Supports Base, Optimism, Unichain, Arbitrum, Polygon, BNB, Ethereum. NOT for cross-chain bridging.
license: Apache-2.0
metadata:
  version: "0.1.0"
  cliVersion: "4.0.0"
---

# Ophis — MEV-protected swaps via the MetaMask Agent Wallet

Same-chain token swaps through **Ophis**, an intent-settlement layer on **CoW Protocol**. Instead of routing through an AMM (where the trade can be sandwiched), Ophis submits a signed *intent* that solvers compete to fill in a **batch auction**: uniform clearing price, surplus returned to the trader, MEV-protected, and gasless (solvers pay settlement gas). The MetaMask Agent Wallet signs the order with a real **EIP-712** signature — no presign.

This is complementary to MetaMask's built-in `mm swap` (its own aggregator route): use this skill when the user specifically wants **MEV-protected / CoW / Ophis** execution.

## When to use

- The user asks to swap two tokens **on the same chain** and wants MEV protection / best execution / "no sandwich" / CoW / Ophis.
- Do NOT use for cross-chain bridging (use `mm swap` with `--to-chain`, or a bridging skill).
- Native ETH is not supported — swap WETH (and unwrap separately).

## Prerequisites

1. MetaMask Agent Wallet ready: `mm doctor` shows `authenticated` + `initialized` (run `mm login` and `mm init` if not). Free Early Access enrollment at metamask.io/agent-wallet.
2. Python 3 and a keccak library (`pip install pysha3` or `pycryptodome` or `'eth-hash[pycryptodome]'`).
3. The wallet holds the sell token plus a little native gas for the one-time ERC-20 approval. Confirm the chain is available: `mm chains list`.

## How it works (the CoW intent flow)

1. **Quote** — `POST {orderbook}/api/v1/quote` for the buy amount + fee.
2. **appData** — build the Ophis partner-fee appData (this routes the fee to Ophis + carries your referral code) and its `keccak256` hash.
3. **Publish appData** — `PUT {orderbook}/api/v1/app_data/{hash}` so solvers can read the fee.
4. **Approve** — `mm wallet send-transaction` an `approve(VaultRelayer, amount)` on the sell token.
5. **Sign** — `mm wallet sign-typed-data --wait` the GPv2 order (EIP-712) → a 0x signature.
6. **Submit** — `POST {orderbook}/api/v1/orders` with `signingScheme: "eip712"` + the signature → order UID.

> Always pass `--wait` to the `mm` signing/tx commands — without it they return a `pollingId`, not the signature/hash.

## Quick start

### Quote (no wallet needed)
```bash
python3 scripts/ophis-quote.py <chain_id> <sell_token> <sell_decimals> <amount> <buy_token> <buy_decimals>
# 100 USDC -> WETH on Base:
python3 scripts/ophis-quote.py 8453 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 6 100 0x4200000000000000000000000000000000000006 18
```

### Swap
```bash
python3 scripts/ophis-swap.py <chain_id> <sell_token> <sell_decimals> <amount> <buy_token> <buy_decimals> [slippage_bps] [referral_code]
```
- `slippage_bps` — optional, basis points (default 50 = 0.5%; capped at 5000).
- `referral_code` — optional; earns the Ophis rebate. Mint one at https://swap.ophis.fi/#/rewards.
- Prints the order UID + an `explorer.ophis.fi` tracking link.

## Supported chains

See `references/chains-and-tokens.md` for chain IDs, the CoW Settlement + VaultRelayer per chain, and common token addresses. Optimism (10) and Unichain (130) are Ophis-sovereign (100% of price improvement returned). Pass any EIP-155 chain id `mm chains list` supports; Ophis covers Ethereum, Optimism, BNB, Gnosis, Unichain, Polygon, Base, Ink, Arbitrum, Avalanche, Linea.

## Notes

- **Same-chain only.** Cross-chain → `mm swap --to-chain` or a bridging skill.
- **Gasless swap**, but the approve is an on-chain tx the wallet pays gas for; the settlement itself is gasless.
- **Blockaid / Guard mode:** `mm` runs simulation + Blockaid on every tx and may flag `approve`; in Guard mode a wallet policy may gate it. Confirm the approve if prompted. See `references/api.md`.
- **Integrator fee / referral** rides in `appData` — that's how a swap is attributed to Ophis and how an integrator earns the rebate.
