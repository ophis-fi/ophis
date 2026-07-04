---
id: agent-swap-comparison
title: How does an AI agent swap safely
description: A guide to giving an autonomous agent the ability to swap tokens safely: the properties that bound an agent's worst case (keyless, machine-signable, hard limit price, MEV protection, gasless, native BTC) and how Ophis provides each.
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
- **Bounded worst case.** When the agent signs, is the maximum loss knowable at
  signing time (a hard limit price), or is it an arbitrary transaction whose
  outcome depends on execution?
- **MEV protection.** Is the order shielded from sandwiching by construction, or
  exposed in a public mempool?
- **Gasless.** Does the agent need a native gas token on every chain, or does a
  solver pay the gas?

## How Ophis addresses each property

- **Keyless to quote and build.** The Ophis MCP server at
  `https://mcp.ophis.fi/mcp` needs no API key, OAuth, or signup: an agent quotes
  and builds an order with no credential in its environment.
- **Machine-signable.** `build_order` returns an EIP-712 order the agent signs
  directly with its own key. There is no handoff to a human browser step.
- **Bounded worst case.** The order carries a hard limit price and a pinned
  receiver, so the maximum loss is known at signing time and it cannot settle
  below the price the agent signed.
- **MEV protection.** Orders settle in a batch auction at a uniform clearing
  price, so there is no public pending transaction to sandwich, by construction
  rather than best-effort.
- **Gasless (after a one-time approval).** Solvers pay the settlement gas. The
  one on-chain step is a single ERC-20 approval to the vault relayer before the
  first sell of a token; after that, swaps need no native gas token.
- **Reach.** 12 EVM chains as source or destination, plus native Bitcoin and
  Solana as destinations through NEAR Intents.

## Where other venues sit

Other agent-facing swap interfaces (1inch, OKX, Jupiter, deBridge, Coinbase's
Base MCP, and CoW Swap's SDK) each cover a subset of these properties, and their
capabilities move quickly, so check each venue's current docs rather than trust
a snapshot here. Two things are worth knowing when you compare:

- The safest primitive for an autonomous agent is an **intent order**: a
  gasless, limit-priced, receiver-pinned EIP-712 signature whose worst case is
  known before signing, not an arbitrary transaction or router calldata. Ophis
  and CoW Swap both use this batch-auction model; CoW Swap does not currently
  publish an MCP server, and Ophis adds the keyless MCP and native Bitcoin.
- Several venues offer keyless or gasless paths and slippage-bounded swaps; what
  is specific to the batch-auction model is uniform-clearing-price MEV
  protection and a hard signed limit that the settlement contract enforces.

## What "safe" does and does not mean here

An intent order bounds the blast radius: the receiver is pinned to the owner, so
proceeds cannot be redirected to a third party, and the limit price caps the
downside of any single fill. It does **not** turn a bad decision into a good one:
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
to the owner, and embeds the flat 5 bps partner fee, so the returned order is bounded
before your agent signs it.
