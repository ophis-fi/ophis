# @ophis/agentkit-ophis

A [Coinbase AgentKit](https://github.com/coinbase/agentkit) action provider that lets an AI agent swap ERC-20 tokens via **Ophis**: intent-based batch settlement. Orders carry the Ophis partner fee and optional referral attribution on indexed chains.

## Install

```sh
npm i @ophis/agentkit-ophis @coinbase/agentkit
```

## Use

```ts
import { AgentKit } from '@coinbase/agentkit';
import { ophisActionProvider } from '@ophis/agentkit-ophis';

const agentKit = await AgentKit.from({
  walletProvider, // any EvmWalletProvider (Viem, CDP, Privy, ZeroDev…)
  actionProviders: [
    ophisActionProvider({ referralCode: process.env.OPHIS_REFERRAL_CODE }),
    // (or set OPHIS_REFERRAL_CODE and call ophisActionProvider())
  ],
});
```

This registers an **`OphisActionProvider_swap`** action:

| Param | |
|---|---|
| `sellToken` | ERC-20 address (native ETH not supported — use WETH) |
| `buyToken` | ERC-20 address |
| `sellAmount` | whole units, e.g. `"1.5"` |
| `slippageBps` | max slippage in bps, or `null` for the default (50 = 0.5%) |

It quotes against the Ophis orderbook, signs the order EIP-712 via the wallet provider, approves the vault relayer once, submits, and returns a JSON string with the order UID + an explorer URL.

## Notes

- **ERC-20 → ERC-20 only.** Native-ETH sells need the native-ETH order path (a separate path); wrap to WETH first.
- The agent's wallet is the order **owner and receiver** — funds only ever move through the chain-specific settlement contract, with purchased tokens returned to the same wallet.
- Version 0.3.8 uses SDK 0.4.6. An EVM wallet can trade on its supported chains, including Arc (5042), using ERC-20 addresses. Configured referral defaults apply on Arc; native USDC sentinels are rejected.
- Get a referral code (it carries the rebate): https://docs.ophis.fi/ai-agents

The order-flow core is [`@ophis/agent-swap`](../agent-swap); see also [`@ophis/plugin-goat`](../plugin-goat) for the GOAT SDK.

For shielded balances and private swaps, use the separate [privacy pools flow](https://docs.ophis.fi/privacy-pools); these adapters submit public orderbook orders.
