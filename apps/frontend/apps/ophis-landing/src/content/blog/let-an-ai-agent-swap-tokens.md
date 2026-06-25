---
title: "How to let an AI agent swap tokens — safely, and MEV-protected"
description: "Agents can already pay. Swapping is the harder, riskier half. Here's how to give an AI agent the ability to swap tokens through Ophis — via an MCP server, the Intent API, or the SDK — with the safety rails (bounded orders, a pinned receiver, MEV-protected settlement) that stop an autonomous signer from draining itself."
pubDate: 2026-06-25
author: Ophis
tags: [ai-agents, mcp, mev, defi, swaps]
---

2026 is the year AI agents got wallets. Giving an agent the ability to *pay*
is largely a solved problem now — stablecoin rails, x402, and a handful of
provider SDKs cover it. Giving an agent the ability to **swap** — to turn one
token into another at a fair price, without getting picked off — is the harder
half. It's also where naive integrations quietly lose money.

This is a walkthrough of wiring swaps into an agent through Ophis, and — more
importantly — the safety model that keeps an autonomous signer from turning into
an autonomous victim.

## Paying is easy. Swapping is where it goes wrong.

A payment is a one-sided transfer. A swap is an *adversarial* action on a public
mempool. The instant an agent broadcasts a market swap, searchers can sandwich
it — buy in front, sell behind, and pocket the spread. A human does this
occasionally; an agent that rebalances or DCAs on a schedule is a predictable,
high-frequency, fully-automated target. The MEV tax compounds on every trade.

And an autonomous signer has no wallet pop-up to catch a bad order. The three
things a human would notice in a confirmation dialog all fail **silently** for a
machine:

- a **receiver** set to an address that isn't the owner — the bought tokens land
  somewhere else, and the signature makes it irreversible;
- an **unbounded price** — the order fills far below the quote the agent reasoned
  about;
- a **wrong settlement contract or orderbook host** — the order routes around
  your solver and collects nothing.

Ophis is built for exactly this. It's **intent-based**: you don't broadcast a
swap, you sign a *bounded order* and a competitive solver network races to fill
it. It's **MEV-protected**: orders settle in batch auctions at a uniform
clearing price, so there's no in-batch ordering to exploit — no sandwiching. And
the agent signs a **bounded capability**, not an arbitrary transaction.

## The fastest path: point your agent at the MCP server

If your agent speaks the [Model Context Protocol](https://modelcontextprotocol.io),
you don't have to write any swap code. Ophis runs a hosted, streamable-HTTP MCP
server:

```
https://mcp.ophis.fi/mcp
```

It exposes six tools:

| Tool | What it does |
| --- | --- |
| `parse_intent` | Parse a natural-language request into a structured intent. |
| `get_quote` | Fetch an executable quote for a parsed intent. |
| `build_order` | Build a bounded, ready-to-sign order (receiver pinned to the owner by default). |
| `submit_order` | Submit a signed order to the correct per-chain orderbook. |
| `lookup_tier` | Look up a wallet's 30-day volume tier and rebate status. |
| `list_chains` | Resolve supported chains and their settlement / orderbook hosts. |

Point any MCP client — Claude, Cursor, or your own agent loop — at the URL:

```json
{
  "mcpServers": {
    "ophis": {
      "type": "http",
      "url": "https://mcp.ophis.fi/mcp"
    }
  }
}
```

The important property: **Ophis never holds keys.** `build_order` hands back a
bounded order with the receiver pinned to the owner; the agent signs it locally;
`submit_order` relays the signature. The signature is the trust boundary — the
agent commits to a specific, bounded order, nothing more.

## Not on MCP? Wrap the Intent API as a tool

Any function-calling agent — LangChain, an OpenAI Assistant, AutoGPT, a custom
tool loop — can call the Intent API directly. It takes free-form text and returns
structured entities you map to a swap link the user signs.

```python
from langchain_core.tools import tool
import requests

@tool
def ophis_swap_intent(text: str) -> dict:
    """Parse a natural-language swap request into a structured Ophis intent and a
    deep link the user can open to review and sign. Use whenever a user wants to
    swap, buy, or sell a token. Always show the link to the user — never
    auto-execute a trade."""
    r = requests.post("https://ophis.fi/api/intent", json={"text": text}, timeout=10)
    r.raise_for_status()
    parsed = r.json()["data"]
    by_type = {e["type"]: e["value"] for e in parsed["entities"]}
    chain_id = {"ethereum": 1, "optimism": 10, "base": 8453}.get(by_type.get("chain"), 1)
    sell, buy = by_type.get("sellToken", "_"), by_type.get("buyToken", "_")
    return {"intent": parsed, "deeplink": f"https://ophis.fi/#/{chain_id}/swap/{sell}/{buy}"}
```

The tool returns both the structured intent (so the agent can reason about the
trade) and a link (so the human can sign it). The full chain map and an
AutoGPT / OpenAI function schema are in the
[AI agent docs](https://docs.ophis.fi/ai-agents).

## Building and signing an order yourself

If you want to place orders programmatically, you build and sign a CoW Protocol
order. Four things must each be exactly right — and every one of them fails
*silently* (a rejected order, a wrong-chain trade, or zero fee collected) if you
guess. The [`@ophis/sdk`](https://www.npmjs.com/package/@ophis/sdk) exists so you
don't have to:

```typescript
import {
  getOphisOrderbookUrl,
  getOphisOrderDomain,
  buildOphisAppDataPartnerFee,
  assertReceiverIsOwner,
} from '@ophis/sdk'

// 1. Resolve the orderbook host from the chain ID. Optimism is self-hosted at
//    optimism-mainnet.ophis.fi, NOT api.cow.fi — the SDK gets this right.
const orderbookUrl = getOphisOrderbookUrl(chainId)

// 2. Build the partner-fee appData (CIP-75 volume shape, the correct rate per
//    chain/pair). This is what attributes the swap — and the rebate — to you.
const partnerFee = buildOphisAppDataPartnerFee(chainId)

// 3. Pin the receiver to the owner BEFORE signing. In the UI a wallet prompt
//    gates this; an autonomous signer has no such gate, so guard it in code.
assertReceiverIsOwner(owner, order.receiver) // throws if receiver !== owner

// 4. Sign EIP-712 typed data against the per-chain domain. The Ophis-operated
//    chains do not use CoW's canonical settlement, so build the domain from the
//    chain ID — never the SDK default.
const signature = await wallet.signTypedData(getOphisOrderDomain(chainId), ORDER_TYPES, order)
```

The [full four-step guide](https://docs.ophis.fi/ai-agents#submitting-orders-programmatically)
covers the appData hashing and the EIP-712 order struct in detail. The
one-line summary: let the SDK resolve anything that's chain-specific.

## Agents that trade *earn* — the rebate

Here's the part that flips swaps from a cost center to a revenue line. Every swap
routed through your integration carries the Ophis partner fee — a flat **0.10%**
(just **0.01%** for stablecoin-to-stablecoin pairs) written into the order's
`appData`. Integrators earn a **rebate** on the volume they route, and the
`lookup_tier` tool surfaces a wallet's 30-day volume tier.

An agent that swaps frequently isn't an expense to its builder — it's recurring,
attributable volume. The more your agent trades, the more you earn back.

## Going fully autonomous (read this first)

Everything above keeps a **human in the signing loop**. The moment you remove
that human and let the agent sign on its own, off-chain helpers stop being
enough — a compromised or prompt-injected agent will sign whatever it's told.
"The human always signs" is a documented social contract, not an enforced
boundary. Before you go unattended, move the boundary into code:

1. **Funds in a smart account (Safe).** The agent never holds the fund-owning
   key — it only *proposes* orders. An EIP-1271 validator or Safe module approves
   only order hashes that satisfy policy.
2. **A deterministic policy gate** between the (untrusted) LLM and any signature:
   tokens from a chain-scoped allowlist only (never an LLM-emitted address);
   receiver pinned to the account; `appData` pinned to the Ophis canonical with
   hooks forced empty; a limit price within X% of an independent, staleness-checked
   oracle; per-trade and rolling-daily notional caps; a short `validTo`.
3. **Containment:** a bounded vault-relayer allowance (the blast radius if policy
   fails once), a guardian key that can pause or revoke signing, keys in an
   HSM/TEE, and a tamper-evident audit trail.
4. **Defense in depth:** enforce the policy in *two* places — the EIP-1271
   validator/signer **and** server-side at orderbook ingestion.

The [autonomous-trading section of the docs](https://docs.ophis.fi/ai-agents#autonomous-agent-trading-advanced)
spells out the full kit. The rule of thumb: an autonomous integrator is one
unpinned `receiver` away from draining itself — so don't ship one until the
policy is in code, not prose.

## Start here

Ophis is the swap layer for the agent era: MEV-protected, self-custody, and
revenue-aligned with the people who integrate it.

- **MCP server:** [`https://mcp.ophis.fi/mcp`](https://mcp.ophis.fi/mcp)
- **AI agent docs:** [docs.ophis.fi/ai-agents](https://docs.ophis.fi/ai-agents)
- **SDK:** [`npm install @ophis/sdk`](https://www.npmjs.com/package/@ophis/sdk)
- **Try a swap:** [swap.ophis.fi](https://swap.ophis.fi/)
