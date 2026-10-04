---
id: agent-swap-comparison
title: How does an AI agent swap safely
description: "A guide to giving an autonomous agent the ability to swap tokens safely: the properties that constrain an agent's orders (keyless quoting, machine signing, hard limit price, MEV mitigation and solver-paid settlement) and how Ophis provides each."
sidebar_label: How agents swap safely
---

# How does an AI agent swap safely

If you are building an autonomous agent that needs to swap tokens, the question
that matters is not "which venue has the best price" but "what is the worst
thing that happens if the agent, or the model driving it, misbehaves." This page
lays out the properties that bound that worst case and how Ophis provides each.

The properties that decide safety for an agent:

- **Keyless to quote and build.** Can the agent get a quote and construct an
  order without provisioning an API key or OAuth token first? Fewer credentials
  in the agent's environment is less to leak.
- **Machine-signable.** Does the interface return something the agent's own
  signer can sign directly, or does it hand off to a human in a browser?
- **Bounded order.** Can the signer inspect and constrain the sell amount,
  minimum received and receiver before signing? A limit price constrains one
  fill, not future token value or cumulative losses.
- **MEV mitigation.** How are orders submitted and settled, and what visibility
  or ordering risks remain?
- **Settlement gas.** Who pays settlement gas, and which approvals or other
  transactions still need native gas?

## How Ophis addresses each property

- **Keyless to quote and build.** The Ophis MCP server at
  `https://mcp.ophis.fi/mcp` needs no API key, OAuth, or signup: an agent quotes
  and builds an order with no credential in its environment.
- **Machine-signable.** `build_order` returns an EIP-712 order the agent signs
  directly with its own key. There is no handoff to a human browser step.
- **Bounded order.** The signed sell amount, minimum buy amount and receiver
  constrain one fill. They do not bound future token value or cumulative losses
  from a compromised signer repeatedly authorizing trades.
- **MEV mitigation.** Offchain orders and uniform clearing prices per token
  pair reduce common ordering advantages. External-pool settlement can still
  be public and exposed to adversarial conditions.
- **Solver-paid ERC-20 settlement.** Approvals, renewed exact allowances,
  wrapping, native-token placement, hard cancellation and refunds can need gas.
- **Reach.** The app supports 14 EVM networks; SDK v0.4.3 and hosted MCP mappings cover
  the same 14, including Arc. NEAR destinations and sources are route-specific. The
  [BTC cookbook](./agent-btc-cookbook.md) describes a custom composition, not a
  shipped one-call BTC MCP tool.

## Where other venues sit

Other agent-facing swap interfaces (1inch, OKX, Jupiter, deBridge, Coinbase's
Base MCP, and CoW Swap's SDK) each cover a subset of these properties, and their
capabilities move quickly, so check each venue's current docs rather than trust
a snapshot here. Two things are worth knowing when you compare:

- A receiver-pinned, limit-priced intent can constrain one trade. It is not
  automatically safer than every transaction: safety also depends on signer
  policy, approvals, chosen assets, price limits and cumulative spend.
- Several venues offer keyless or gasless paths and slippage-bounded swaps; what
  is specific to the batch-auction model is uniform-clearing-price MEV
  protection and a hard signed limit that the settlement contract enforces.

## What "safe" does and does not mean here

An order from Ophis's builder pins the receiver to the owner and fixes the
minimum received for one fill. It does **not** turn a bad decision into a good one:
if the agent chooses to sell the wrong token, or signs a limit price that is
worse than the market, the order still executes within those bounds. Pair the
intent primitive with a policy wallet (see
[Agent wallet policies](./ai-agents.md#autonomous-agent-trading-advanced)) so the
agent can only sign Ophis orders, to an allowlisted token set, with the receiver
pinned to itself.

## Try it

Point any MCP client at `https://mcp.ophis.fi/mcp` (no key), or read the
[AI agent integration guide](./ai-agents.md). Prefer `build_order` to construct
orders: it fetches a live quote, applies your slippage bound, pins the receiver
to the owner, and applies the chain-specific Ophis policy: a 1 bp base plus
80% of reference-quote improvement capped at 99 bps on volatile pairs, or 50%
capped at 20 bps on stable pairs. Operated-chain backends add the improvement
policy; hosted orders encode it in CIP-75 appData. Eligible settled Arc orders support referral accrual. The returned order is bounded
before your agent signs it.
