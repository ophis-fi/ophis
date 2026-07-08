---
title: "AI agent token swaps with GOAT or Coinbase AgentKit"
description: "Wire a swap tool into a GOAT SDK or Coinbase AgentKit agent with Ophis: bounded orders, pinned receiver, capped slippage, gasless MEV-protected settlement."
pubDate: 2026-07-12
author: Ophis
tags: [ai-agents, goat, agentkit, mev, swaps]
draft: false
cover: ./ai-agent-swaps-goat-agentkit.cover.jpg
coverAlt: "Ophis emblem ringed by chain logos, a DEX aggregator for AI agents"
---

To add token swaps to a TypeScript AI agent, install `@ophis/plugin-goat` (for the GOAT SDK) or `@ophis/agentkit-ophis` (for Coinbase AgentKit) and register it with your framework. Either package hands the agent a single swap tool that quotes the trade, builds a bounded order, signs it EIP-712 with the agent's own key, and settles it through [Ophis](https://ophis.fi/), the intent-based DEX aggregator at ophis.fi: gasless, MEV-protected, receiver pinned to the signing wallet. The rest of this post is the wiring for both frameworks, plus the safety model behind that one tool.

This is the sequel to [our walkthrough of agent swaps via MCP, the Intent API, and the SDK](/blog/let-an-ai-agent-swap-tokens/). That post explains why an autonomous signer needs *bounded orders* instead of market swaps; this one is the TypeScript integration, with minimal glue code.

## What the swap tool actually does

Both packages register one capability (GOAT names the tool `ophis_swap`; AgentKit exposes an `OphisActionProvider_swap` action) with identical behavior underneath. On each call, the package:

1. quotes the trade against the Ophis orderbook for the wallet's chain,
2. applies the slippage cap (default 50 bps) to derive a minimum buy amount, which the order carries as a hard limit price,
3. signs the order as EIP-712 typed data with the agent's own wallet,
4. approves the vault relayer of the chain's settlement deployment once (a standard ERC-20 allowance),
5. submits the order and returns the order UID plus an explorer URL.

From there it is Ophis's normal intent flow: a competing solver network races to fill the order, and settlement lands in a batch auction at a uniform clearing price. No pending swap ever sits in a public mempool, so there is nothing to sandwich; [MEV protection](/blog/mev-protection-batch-auctions/) is structural, not best-effort. If a solver fills above the signed minimum, the Ophis fee takes no share of the price improvement, and on Optimism and Unichain 100% of it goes to the wallet (on the chains that settle through CoW Protocol, CoW Protocol keeps half). And orders are [gasless](/blog/gasless-swaps-how-intents-work/) (no native token needed; the fee is taken from the sell token): the only transaction the agent ever broadcasts is that one-time approval.

The packages also resolve the per-chain orderbook and EIP-712 settlement domain for you: on some chains Ophis runs its own bytecode-identical deployment of CoW Protocol's audited GPv2Settlement, on the rest orders settle through the canonical audited contracts. Guessing either value by hand produces silently rejected or misrouted orders.

## Wiring a GOAT agent

GOAT surfaces one plugin through its adapters for Vercel AI, LangChain, Mastra, Eliza, or MCP.

```sh
npm i @ophis/plugin-goat @goat-sdk/core @goat-sdk/wallet-evm @goat-sdk/wallet-viem
```

Add the plugin next to your wallet (the example uses the Vercel AI adapter):

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

That registers an `ophis_swap` tool the model can call:

| Param | What it takes |
| --- | --- |
| `sellToken` | ERC-20 address (native ETH not supported; wrap to WETH first) |
| `buyToken` | ERC-20 address |
| `sellAmount` | whole units, e.g. `"1.5"` |
| `slippageBps` | optional, default `50` (0.5%) |

## Wiring a Coinbase AgentKit agent

AgentKit wires the same capability as an action provider, against its EOA-backed EVM wallet providers:

```sh
npm i @ophis/agentkit-ophis @coinbase/agentkit
```

```ts
import { AgentKit } from '@coinbase/agentkit';
import { ophisActionProvider } from '@ophis/agentkit-ophis';

const agentKit = await AgentKit.from({
  walletProvider, // any EOA-backed EvmWalletProvider (Viem, CDP, Privy); smart accounts need the presign path, not this flow
  actionProviders: [
    ophisActionProvider({ referralCode: process.env.OPHIS_REFERRAL_CODE }),
    // (or set OPHIS_REFERRAL_CODE and call ophisActionProvider())
  ],
});
```

This registers the `OphisActionProvider_swap` action with the same four parameters as the GOAT tool (here `slippageBps` takes `null` for the default) and returns the order UID and explorer URL as JSON.

Both plugins run on supported EVM chains; the READMEs in the [Ophis monorepo](https://github.com/ophis-fi/ophis) list the current set.

## The shared core: @ophis/agent-swap

The two plugins are thin adapters over `@ophis/agent-swap`, a framework-agnostic core where the order flow is written and tested once: quote, fee-bearing appData, EIP-712 signature, relayer approval, submission, rebate enrollment. If your agent runs on neither framework, implement the five-method `OphisAgentWallet` interface (`getAddress`, `getChainId`, `readErc20Decimals`, `ensureErc20Allowance`, `signTypedData`) and call the core directly:

```ts
import { executeOphisSwap, type OphisAgentWallet } from '@ophis/agent-swap';

const result = await executeOphisSwap(
  wallet, // your OphisAgentWallet
  { sellToken, buyToken, sellAmount: '1.5' /* whole units */, slippageBps: 50 },
  { referralCode: process.env.OPHIS_REFERRAL_CODE! },
);
// result.orderUid, result.explorerUrl, result.minBuyAmount
```

All three packages are published on npm with provenance.

## The safety rails

An autonomous signer has no confirmation dialog, so the properties a human would eyeball must hold by construction:

- **Hard limit price.** The signed order carries a minimum buy amount; a fill below it is invalid.
- **Receiver pinned to the signer.** The agent's wallet is the order owner *and* receiver. Funds only ever move through the settlement contract, back to the same wallet; a prompt-injected "send the proceeds elsewhere" has no parameter to grab.
- **Slippage capped.** `slippageBps` bounds the gap between quote and worst acceptable fill, defaulting to 0.5%.
- **The agent's own key.** Signing happens inside your process, via the wallet you constructed; nothing custodial.
- **Batch settlement.** Uniform clearing price, order flow kept off the public mempool: sandwiching is removed structurally.
- **Gasless.** No native-token float to manage (or drain) beyond the one-time relayer approval.

Two limits to plan around: the flow is ERC-20 to ERC-20 only (wrap native ETH to WETH first), and it signs as an EOA via `signTypedData`, not as a Safe. Before removing the human from the loop entirely, read the autonomous-agent section of the first post: unattended operation also needs policy gates and spend caps around the signer.

## The referral code pays the builder

Both snippets pass a `referralCode`. Every order carries the Ophis partner fee plus that code in its appData, attributing the swap volume your agent routes to you: you earn 8% of the net fee Ophis keeps on that volume, paid monthly in WETH (standard tier capped at $1M referred volume per month; an invitation-only Partner tier pays 12%, uncapped). Mint a code at [swap.ophis.fi/#/affiliate](https://swap.ophis.fi/#/affiliate) (details in the [AI agent docs](https://docs.ophis.fi/ai-agents)).

## Not writing TypeScript? Use the MCP server

If the agent is not TypeScript (an MCP-native setup, a Python loop, anything that speaks HTTP), point it at the hosted MCP server at [mcp.ophis.fi/mcp](https://mcp.ophis.fi/mcp): keyless, unauthenticated, all 12 supported chains, 12 tools from `parse_intent` to `submit_order`, and the same rule that the agent signs locally with its own key. The [first post](/blog/let-an-ai-agent-swap-tokens/) walks through it.

## FAQ

### Does Ophis hold my agent's keys?

No. The packages sign locally through the wallet object you construct (a viem account for GOAT, an `EvmWalletProvider` for AgentKit, your own `signTypedData` for the core), and only the signed order leaves your process. Ophis is self-custodial: it never holds funds, and nothing settles without the EIP-712 signature your agent produced.

### What stops the agent from draining itself?

The order it signs is bounded: the receiver is the signing wallet itself, the minimum buy amount is a hard limit price derived from the quote and the slippage cap, and funds can only move through the settlement contract back to the same wallet. A bad model output can produce a bad trade within those bounds, but it cannot redirect proceeds or sign away unbounded value in one order. For fully unattended operation, add policy gates as covered in the first post.

### Should I pick GOAT or AgentKit?

Whichever framework your agent already runs on; the swap behavior is identical because both wrap `@ophis/agent-swap`. GOAT reaches Vercel AI, LangChain, Mastra, Eliza, and MCP through its adapters; AgentKit fits the Coinbase stack and its wallet providers. On neither? Implement the five-method wallet interface against the core, or use the MCP server with no npm dependency at all.

### What does this cost?

The packages are free and open source. The plugins embed the Ophis SDK partner fee: a flat 0.05% (5 bps) of trade volume, taken from the sell token, and it takes no share of any surplus. The plugins apply this flat 5 bps to every pair; the reduced 0.01% (1 bp) stablecoin rate is applied only if you call the `@ophis/agent-swap` core directly with `isStablePair: true`. (The Ophis swap website charges the retail 0.10%.) On Optimism and Unichain, where Ophis runs its own settlement, that fee is the whole cost and 100% of price improvement stays with the wallet; on the chains that settle through CoW Protocol, CoW Protocol's protocol fee applies on top (all-in about 0.07%) and CoW Protocol keeps half of any price improvement. Details at [docs.ophis.fi/fees](https://docs.ophis.fi/fees) and, for CoW Protocol, [docs.cow.fi](https://docs.cow.fi); with a referral code set, 8% of the net fee flows back to you.

## Start here

Fund a dedicated wallet for the agent, set `OPHIS_REFERRAL_CODE`, and add the plugin for your framework. If you want to feel the flow before wiring it, do one trade yourself at [swap.ophis.fi](https://swap.ophis.fi/): the quote, the bounded order, and the batch fill are the same mechanics your agent will run.
