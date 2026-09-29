# @ophis/agent-swap

Framework-agnostic core for executing an **Ophis** (a CoW Protocol fork) ERC-20 swap from an AI agent's **EOA** wallet. It is consumed by [`@ophis/plugin-goat`](../plugin-goat) (GOAT SDK) and [`@ophis/agentkit-ophis`](../agentkit-ophis) (Coinbase AgentKit) — you usually want one of those, not this directly.

The order flow is written and tested once here: build the fee-bearing appData (with optional referral attribution on indexed chains) → quote against the Ophis orderbook → approve the CoW vault relayer → **EIP-712 sign** via your wallet's `signTypedData` (an EOA, not a Safe presign) → submit. Indexed-chain traders are enrolled with the owner-scoped rebate indexer.

## Use from a custom framework

Implement the minimal `OphisAgentWallet` for your agent's wallet (5 methods: `getAddress`, `getChainId`, `readErc20Decimals`, `ensureErc20Allowance`, `signTypedData`), then:

```ts
import { executeOphisSwap, type OphisAgentWallet } from '@ophis/agent-swap';

const result = await executeOphisSwap(
  wallet, // your OphisAgentWallet
  { sellToken, buyToken, sellAmount: '1.5' /* whole units */, slippageBps: 50 },
  { referralCode: wallet.getChainId() === 5042 ? undefined : process.env.OPHIS_REFERRAL_CODE },
);
// result.orderUid, result.explorerUrl, result.minBuyAmount
```

ERC-20 → ERC-20 only (the EOA EIP-712 path; native-ETH sells need CoW eth-flow). The agent's wallet is the order owner **and** receiver. Get a referral code at https://docs.ophis.fi/ai-agents.

Version 0.3.6 uses SDK 0.4.4, including Arc (5042). Arc orders use ERC-20 token addresses and the 1 bp base fee. Arc traders are enrolled for indexing, and optional `referralCode` tags eligible settled orders. Enrollment failures return a warning without blocking the swap.
