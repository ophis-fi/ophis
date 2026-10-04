---
id: agent-btc-cookbook
title: Swap into native Bitcoin from an agent
description: Compose an Ophis ERC-20 order with NEAR Intents delivery to Bitcoin or Solana, with separate source-order, destination and recovery checks.
sidebar_label: Native BTC for agents
---

# Swap into native Bitcoin from an agent

Among intent-based batch-auction swap venues, Ophis packages a gasless,
source-order path to **native Bitcoin** alongside the app's 14 EVM networks.
SDK v0.4.3 and hosted MCP mappings cover the same 14 networks, including Arc. Source and asset
support for NEAR routes is narrower than the same-chain list. The cross-chain rail (NEAR Intents) is shared by several venues; what Ophis packages is the
keyless, bounded agent path onto it. This page shows how an agent
or bot moves an EVM position into native BTC (or SOL) after a one-time
source-token approval, with no Bitcoin-side signing and without clicking through
a bridge UI.

The standalone app also supports externally funded Bitcoin and Solana sources.
That deposit flow is separate from the EVM-order composition described here and
is not a new MCP tool. See [Networks & assets](./networks-assets.md).

## The mechanism

A Bitcoin address cannot receive an ERC-20, so the cross-chain leg runs through
[NEAR Intents](https://near.org/intents), a cross-chain settlement layer. The
shape is:

1. Ask NEAR Intents (its 1-Click flow) for a **deposit address** on the source
   EVM chain that is bound to the agent's target BTC address.
2. Build a normal Ophis swap order whose **receiver is that deposit address**:
   sell the EVM token, buy the intermediate asset the deposit address expects.
3. The agent signs the EIP-712 order with its own key. A solver settles it, the
   proceeds land at the NEAR Intents deposit address, and NEAR Intents brokers
   delivery to the agent's Bitcoin address.

The agent signs once, on the source chain. It supplies a destination Bitcoin
address it controls and signs nothing on the Bitcoin side. Source approvals
and other wallet transactions can require gas. The EIP-712 limit bounds the
**source swap**, not final BTC delivery; the provider quote governs that leg.

## App and agent coverage

The Ophis **web app** supports BTC and SOL destination routes when assets and
quotes permit. The hosted MCP server has no `swap_to_btc` or `swap_to_sol` tool.
An agent integration must implement and validate the two-leg composition itself.
The following is conceptual pseudocode, not a runnable 1-Click API example.
Verify source/deposit asset, amount, destination, expiry and refund data before
signing; do not override a receiver after signing or reuse mismatched quotes:

```ts
// 1. Get a 1-Click deposit address for the target BTC address (NEAR Intents).
//    See the NEAR Intents 1-Click docs for the exact request shape and the
//    per-quote deposit address it returns.
const deposit = await oneClickQuote({
  fromChain: 'optimism',
  fromToken: sellToken,        // the EVM asset the agent holds
  toAsset: 'BTC',
  toAddress: agentBtcAddress,  // the agent's native BTC address
});

// 2. Build an Ophis order with receiver = the deposit address, using @ophis/sdk.
//    getOphisOrderbookUrl / getOphisOrderDomain resolve the correct per-chain
//    host and signing domain. The order sells the EVM token for the asset the
//    deposit address expects, delivered to `deposit.depositAddress`.
const order = {
  ...quotedOrder,
  receiver: deposit.depositAddress,
};

// 3. The agent signs `order` as EIP-712 and submits it DIRECTLY to the
//    orderbook. Note: the keyless MCP `submit_order` tool pins the receiver to
//    the owner as a drain guard, so it will NOT relay this order (the receiver
//    is the 1-Click deposit address, not the owner by design). Submit it to the
//    chain's supported orderbook only after quote/deposit validation. Keep
//    recovery state and track destination delivery separately from the source fill.
```

See the [partner integration guide](./partners.md) for the exact order-build
calls and the [AI agent integration guide](./ai-agents.md) for the keyless MCP
path.

## Why an agent should care

- **One signature, minimal gas.** The agent does not fund a wallet on the
  destination chain and does no Bitcoin-side signing; it supplies a BTC address
  to receive at and signs an order on the source chain. The solver pays standard
  ERC-20 settlement gas; approvals, renewed allowances, cancellation or recovery
  transactions may still require gas.
- **Bounded, with one caveat.** The limit price caps the fill, and the signed
  receiver cannot be mutated after the agent signs. But note the ordering: a
  compromised or prompt-injected agent could request a 1-Click deposit address
  bound to an ATTACKER's BTC address in step 1, and then the signed receiver
  would correctly point at that attacker-bound deposit. The signature prevents
  tampering after construction, not a bad destination chosen before it. For an
  autonomous agent, enforce the destination out of band: an allowlist or
  attestation that the BTC address (and thus the 1-Click deposit address) is one
  the operator approved, checked in code before signing.
- **Checkable.** Both legs are observable: the EVM settlement on chain and the
  NEAR Intents delivery. The EVM leg is non-custodial (a signed intent settled
  on-chain); the cross-chain delivery is brokered by NEAR Intents, so review its
  settlement model for the guarantees on that leg.

## Caveats

- The BTC and SOL rails are provided by NEAR Intents, which several venues also
  use; the differentiator is the packaged gasless, hard-limit, keyless path from
  an agent, not exclusive access to the rail.
- Delivery to Bitcoin is not instant; treat the second leg as asynchronous and
  poll or subscribe for its status before assuming completion.
