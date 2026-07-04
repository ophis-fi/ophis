---
id: agent-btc-cookbook
title: Swap into native Bitcoin from an agent
description: How an autonomous agent or bot moves an EVM position into native Bitcoin (or Solana) in one gasless intent through Ophis, using the NEAR Intents rail, with the agent holding no gas token on any chain.
sidebar_label: Native BTC for agents
---

# Swap into native Bitcoin from an agent

Among intent-based batch-auction swap venues, Ophis packages a gasless,
hard-limit path to **native Bitcoin** next to 12 EVM chains. The cross-chain
rail (NEAR Intents) is shared by several venues; what Ophis packages is the
keyless, bounded agent path onto it. This page shows how an agent
or bot moves an EVM position into native BTC (or SOL) without holding a gas token
on any chain and without handing custody to a bridge UI.

## The mechanism

A Bitcoin address cannot receive an ERC-20, so the cross-chain leg runs through
[NEAR Intents](https://near.org/intents), a non-custodial settlement layer. The
shape is:

1. Ask NEAR Intents (its 1-Click flow) for a **deposit address** on the source
   EVM chain that is bound to the agent's target BTC address.
2. Build a normal Ophis swap order whose **receiver is that deposit address**:
   sell the EVM token, buy the intermediate asset the deposit address expects.
3. The agent signs the EIP-712 order with its own key. A solver settles it, the
   proceeds land at the NEAR Intents deposit address, and NEAR Intents brokers
   delivery to the agent's Bitcoin address.

The agent signs once, on the source chain. It supplies a destination Bitcoin
address it controls, but signs nothing on the Bitcoin side and holds no gas
token on any chain. The order is still a bounded intent: it cannot fill below
the price the agent signed.

## Today vs the packaged tool

The BTC and SOL destination flow is live in the Ophis **web app** today, where a
person composes it. For an **agent**, there is no single wrapped tool yet: a
keyless `swap_to_btc` / `swap_to_sol` MCP tool that combines the two legs is on
the roadmap, not shipped;
until it ships, an agent composes the two calls directly:

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
//    chain's Ophis orderbook yourself. After the one-time sell-token approval,
//    no further gas is needed on the source chain.
```

See the [partner integration guide](./partners.md) for the exact order-build
calls and the [AI agent integration guide](./ai-agents.md) for the keyless MCP
path.

## Why an agent should care

- **One signature, minimal gas.** The agent does not fund a wallet on the
  destination chain and does no Bitcoin-side signing; it supplies a BTC address
  to receive at and signs one intent on the source chain. The only on-chain gas
  is the one-time sell-token approval to the vault relayer before the first
  sell; after that the swap itself is gasless.
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
  NEAR Intents delivery. Nothing is custodial in between.

## Caveats

- The BTC and SOL rails are provided by NEAR Intents, which several venues also
  use; the differentiator is the packaged gasless, hard-limit, keyless path from
  an agent, not exclusive access to the rail.
- Delivery to Bitcoin is not instant; treat the second leg as asynchronous and
  poll or subscribe for its status before assuming completion.
