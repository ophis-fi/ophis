# @ophis/agent-swap

Framework-agnostic core for executing an **Ophis** (a CoW Protocol fork) ERC-20 swap from an AI agent's **EOA** wallet. It is consumed by [`@ophis/plugin-goat`](../plugin-goat) (GOAT SDK) and [`@ophis/agentkit-ophis`](../agentkit-ophis) (Coinbase AgentKit) — you usually want one of those, not this directly.

The order flow is written and tested once here: quote against the Ophis orderbook → build the fee-bearing appData (so the integrator earns the 8–12% rebate) → **EIP-712 sign** via your wallet's `signTypedData` (an EOA, not a Safe presign) → approve the CoW vault relayer → submit → enroll the trader with the owner-scoped rebate indexer.

## Use from a custom framework

Implement the minimal `OphisAgentWallet` for your agent's wallet (5 methods: `getAddress`, `getChainId`, `readErc20Decimals`, `ensureErc20Allowance`, `signTypedData`), then:

```ts
import { executeOphisSwap, type OphisAgentWallet } from '@ophis/agent-swap';

const result = await executeOphisSwap(
  wallet, // your OphisAgentWallet
  { sellToken, buyToken, sellAmount: '1.5' /* whole units */, slippageBps: 50 },
  { referralCode: process.env.OPHIS_REFERRAL_CODE! },
);
// result.orderUid, result.explorerUrl, result.minBuyAmount
```

ERC-20 → ERC-20 only (the EOA EIP-712 path; native-ETH sells need CoW eth-flow). The agent's wallet is the order owner **and** receiver. Get a referral code at https://docs.ophis.fi/ai-agents.
