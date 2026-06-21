# @ophis/plugin-goat

A [GOAT SDK](https://github.com/goat-sdk/goat) plugin that lets an AI agent swap ERC-20 tokens via **Ophis** (a CoW Protocol fork): gasless, MEV-protected, intent-based settlement. Every order carries the Ophis partner fee **plus your referral code** in its appData, so **you earn the 8–12% rebate** on the swap volume your agent routes.

## Install

```sh
npm i @ophis/plugin-goat @goat-sdk/core @goat-sdk/wallet-evm @goat-sdk/wallet-viem
```

## Use

```ts
import { getOnChainTools } from '@goat-sdk/adapter-vercel-ai'; // or langchain / mastra / eliza / mcp
import { viem } from '@goat-sdk/wallet-viem';
import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import { ophis } from '@ophis/plugin-goat';

const walletClient = createWalletClient({
  account: privateKeyToAccount(process.env.WALLET_PRIVATE_KEY as `0x${string}`),
  chain: base,
  transport: http(),
});

const tools = await getOnChainTools({
  wallet: viem(walletClient),
  plugins: [ophis({ referralCode: process.env.OPHIS_REFERRAL_CODE! })],
});
```

This registers an **`ophis_swap`** tool the agent can call:

| Param | |
|---|---|
| `sellToken` | ERC-20 address (native ETH not supported — use WETH) |
| `buyToken` | ERC-20 address |
| `sellAmount` | whole units, e.g. `"1.5"` |
| `slippageBps` | optional, default `50` (0.5%) |

It quotes against the Ophis orderbook, signs the order EIP-712 with the agent's wallet, approves the CoW vault relayer once, submits, and returns the CoW order UID + an explorer URL.

## Notes

- **ERC-20 → ERC-20 only.** Native-ETH sells need CoW eth-flow (a separate path); wrap to WETH first.
- The agent's wallet is the order **owner and receiver** — funds only ever move through the audited CoW settlement contract, back to the same wallet.
- Supported chains: Ethereum, Gnosis, Arbitrum, Base, Optimism, Polygon, Avalanche.
- Get a referral code (it carries the rebate): https://docs.ophis.fi/ai-agents

The order-flow core is [`@ophis/agent-swap`](../agent-swap); see also [`@ophis/agentkit-ophis`](../agentkit-ophis) for Coinbase AgentKit.
