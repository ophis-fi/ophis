---
title: "How to let an AI agent swap tokens: safely, and MEV-protected"
description: "Give an AI agent bounded token-swap capabilities through Ophis: MCP execution, an Intent API for parsing, SDK safety helpers, and the signing policies required for unattended operation."
pubDate: 2026-06-25
updatedDate: 2026-09-28
author: Ophis
tags: [ai-agents, mcp, mev, defi, swaps]
cover: ./let-an-ai-agent-swap-tokens.cover.png
coverAlt: "Ophis: intent-based DEX aggregator for the agent era"
---

2026 is the year AI agents got wallets. Giving an agent the ability to *pay* is
largely a solved problem now: stablecoin rails, x402, and a handful of provider
SDKs cover it. Giving an agent the ability to **swap**, to turn one token into
another at a fair price without getting picked off, is the harder half. It is
also where naive integrations quietly lose money.

This is a walkthrough of wiring swaps into an agent through Ophis, and, more
importantly, the safety model that keeps an autonomous signer from turning into
an autonomous victim.

## Paying is easy. Swapping is where it goes wrong.

A payment is a one-sided transfer. A swap is an *adversarial* action on a public
mempool. The instant an agent broadcasts a market swap, searchers can sandwich
it: buy in front, sell behind, and pocket the spread. A human does this
occasionally; an agent that rebalances or DCAs on a schedule is a predictable,
high-frequency, fully-automated target. The MEV tax compounds on every trade.

And an autonomous signer has no wallet pop-up to catch a bad order. The three
things a human would notice in a confirmation dialog all fail **silently** for a
machine:

- a **receiver** set to an address that is not the owner: the bought tokens land
  somewhere else, and the signature makes it irreversible;
- an **unbounded price**: the order fills far below the quote the agent reasoned
  about;
- a **wrong settlement contract or orderbook host**: the order is rejected or
  targets an unintended deployment; this is not a supported fee-free route.

Ophis is built for exactly this. It is **intent-based**: you do not broadcast a
swap, you sign a *bounded order* and a competitive solver network races to fill
it. Batch auctions use a uniform clearing price per token pair to **mitigate common MEV**.
Settlement can still be public; this is not universal sandwich immunity. And
the agent signs a **bounded capability**, not an arbitrary transaction.

## The fastest path: point your agent at the MCP server

If your agent speaks the [Model Context Protocol](https://modelcontextprotocol.io),
you do not have to write any swap code. Ophis runs a hosted, streamable-HTTP MCP
server:

```
https://mcp.ophis.fi/mcp
```

It exposes fourteen tools:

| Tool | What it does |
| --- | --- |
| `parse_intent` | Parse a natural-language request into a structured intent. |
| `resolve_token` | Resolve a token symbol to its canonical address from the trusted token list; fails closed (anti-spoof). |
| `get_quote` | Fetch an executable quote for a parsed intent. |
| `build_order` | Build a bounded, ready-to-sign order (receiver pinned to the owner by default). |
| `submit_order` | Submit a signed order to the correct per-chain orderbook. |
| `lookup_tier` | Look up a wallet's 30-day volume tier and rebate status. |
| `get_integrator_earnings` | Read routed volume, own-fee accrual, referral rebates, and paid-to-date figures for an appCode. |
| `list_chains` | Resolve supported chains and their settlement / orderbook hosts. |
| `get_balances` | Read a wallet's native and ERC-20 balances on one chain. |
| `get_portfolio` | Read a wallet's token balances across multiple chains. |
| `get_gas` | Fetch the current gas price for a chain. |
| `get_token_chart` | Fetch a token's OHLCV price chart. |
| `expected_surplus` | Estimate how much better an Ophis sell-quote beats the open market. |
| `validate_order` | Validate a proposed order against Ophis safety and routing invariants before signing. |

Point any MCP client (Claude, Cursor, or your own agent loop) at the URL:

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
`submit_order` relays the signature. The signature is the trust boundary: the
agent commits to a specific, bounded order, nothing more.

## Not on MCP? Wrap the Intent API as a tool

Any function-calling agent (LangChain, an OpenAI Assistant, AutoGPT, a custom
tool loop) can call the Intent API directly. It takes free-form text and returns
structured entities you map to a swap link the user signs.

```python
from langchain_core.tools import tool
import requests

# The chains the Intent API can return, mapped to their chain IDs (see the docs).
CHAIN_IDS = {
    "ethereum": 1, "optimism": 10, "unichain": 130, "bnb": 56, "gnosis": 100,
    "polygon": 137, "base": 8453, "ink": 57073, "linea": 59144,
    "arbitrum": 42161, "avalanche": 43114, "plasma": 9745, "robinhood": 4663,
}

@tool
def ophis_swap_intent(text: str) -> dict:
    """Parse a natural-language swap request into a structured Ophis intent and a
    deep link the user can open to review and sign. Use whenever a user wants to
    swap, buy, or sell a token. Always show the link to the user, never
    auto-execute a trade."""
    r = requests.post("https://ophis.fi/api/intent", json={"text": text}, timeout=10)
    r.raise_for_status()
    parsed = r.json()["data"]
    by_type = {e["type"]: e["value"] for e in parsed["entities"]}
    chain = by_type.get("chain")
    if chain and chain not in CHAIN_IDS:
        raise ValueError(f"unmapped chain {chain!r}; never silently misroute")
    chain_id = CHAIN_IDS.get(chain, 1)  # no chain named: default to Ethereum
    sell, buy = by_type.get("sellToken", "_"), by_type.get("buyToken", "_")
    return {"intent": parsed, "deeplink": f"https://swap.ophis.fi/#/{chain_id}/swap/{sell}/{buy}"}
```

The tool returns both the structured intent (so the agent can reason about the
trade) and a link (so the human can sign it). The full chain map and an
AutoGPT / OpenAI function schema are in the
[AI agent docs](https://docs.ophis.fi/ai-agents).

## Building and signing an order yourself

If you want to place orders programmatically, you build and sign a CoW Protocol
order. Four things must each be exactly right, and every one of them fails
*silently* (a rejected order, a wrong-chain trade, or zero fee collected) if you
guess. The [`@ophis/sdk`](https://www.npmjs.com/package/@ophis/sdk) exists so you
do not have to. Use these safety helpers with `@cowprotocol/cow-sdk` for quotes and submission, or use the hosted MCP workflow.
Install both packages with `npm i @ophis/sdk @cowprotocol/cow-sdk`.

```typescript
import {
  getOphisOrderbookUrl,
  getOphisOrderDomain,
  buildOphisAppDataPartnerFee,
  assertReceiverIsOwner,
} from '@ophis/sdk'

// 1. Resolve the orderbook host from the chain ID. Optimism is self-hosted at
//    optimism-mainnet.ophis.fi, NOT api.cow.fi, and the SDK gets this right.
const orderbookUrl = getOphisOrderbookUrl(chainId)

// 2. Build the complete partner fee for this chain/pair, including hosted
//    improvement capture. Determine isStablePair from trusted token metadata.
const partnerFee = buildOphisAppDataPartnerFee(chainId, isStablePair)

// 3. Pin the receiver to the owner BEFORE signing. In the UI a wallet prompt
//    gates this; an autonomous signer has no such gate, so guard it in code.
assertReceiverIsOwner(owner, order.receiver) // throws if receiver !== owner

// 4. Sign EIP-712 typed data against the per-chain domain. The Ophis-operated
//    chains do not use CoW's canonical settlement, so build the domain from the
//    chain ID, never the SDK default.
const signature = await wallet.signTypedData(getOphisOrderDomain(chainId), ORDER_TYPES, order)
```

The [full four-step guide](https://docs.ophis.fi/ai-agents#submitting-orders-programmatically)
covers the appData hashing and the EIP-712 order struct in detail. The
one-line summary: let the SDK resolve anything that is chain-specific.

## Agents that trade *earn*: the rebate

Here is the part that flips swaps from a cost center to a revenue line. Every
swap routed through your integration carries the chain-aware Ophis base in
`appData`: **0.01% on the 14 SDK v0.4.3 / hosted MCP chains**. Optimism,
Unichain and Robinhood backends apply capped improvement capture; hosted orders
encode it in appData. Arc currently has no backend improvement capture; its
settled trades are indexed for referral and volume-tier rebates. Use SDK v0.4.4
or later for Arc referral tags. On indexed chains, eligible integrators earn a **rebate** on the volume
they route, and `lookup_tier` surfaces a wallet's 30-day volume tier.

Rebates depend on eligible indexed volume and the applicable program terms.
See the [fee documentation](https://docs.ophis.fi/fees) for the full mechanics.

## Going fully autonomous (read this first)

Everything above keeps a **human in the signing loop**. The moment you remove
that human and let the agent sign on its own, off-chain helpers stop being
enough: a compromised or prompt-injected agent will sign whatever it is told.
"The human always signs" is a documented social contract, not an enforced
boundary. Before you go unattended, move the boundary into code:

1. **Funds in a smart account (Safe).** The agent never holds the fund-owning
   key; it only *proposes* orders. An EIP-1271 validator or Safe module approves
   only order hashes that satisfy policy.
2. **A deterministic policy gate** between the (untrusted) LLM and any signature:
   tokens from a chain-scoped allowlist only (never an LLM-emitted address);
   receiver pinned to the account; `appData` pinned to the Ophis canonical with
   hooks forced empty; a limit price within X% of an independent, staleness-checked
   oracle; per-trade and rolling-daily notional caps; a short `validTo`.
3. **Containment:** a bounded vault-relayer allowance (the blast radius if policy
   fails once), a guardian key that can pause or revoke signing, keys in an
   HSM/TEE, and a tamper-evident audit trail.
4. **Defense in depth:** enforce the policy in *two* places: the EIP-1271
   validator/signer **and** server-side at orderbook ingestion.

The [autonomous-trading section of the docs](https://docs.ophis.fi/ai-agents#autonomous-agent-trading-advanced)
spells out the full kit. The rule of thumb: an autonomous integrator is one
unpinned `receiver` away from draining itself, so do not ship one until the
policy is in code, not prose.

## FAQ

### Can an AI agent swap tokens on its own?

Yes, with a local signer and enforced policy. The hosted MCP server at
`https://mcp.ophis.fi/mcp` handles quotes, order building and submission; signing
stays local. The Intent API only parses text. For a programmatic client, combine
`@ophis/sdk` safety helpers with `@cowprotocol/cow-sdk`. The agent signs a
bounded order with a hard limit price rather than an arbitrary
transaction, so the worst execution it can receive is the one it committed to.
Removing the human is the point at which the policy rails in this article stop
being optional, because a prompt-injected agent will sign whatever it is told.

### Does Ophis hold an agent's private key?

No. The MCP server is keyless and unauthenticated: it never holds keys and never
signs anything. `build_order` returns a ready-to-sign order, the agent signs it
locally with its own key, and `submit_order` relays that signature. The
signature is the trust boundary, which is why the order it covers has to be
bounded before it is produced.

### How do I stop an agent from signing a bad swap?

Four checks catch the failures that a human would otherwise catch in a wallet
prompt. Pin the receiver to the owner before signing (`build_order` does this by
default, and `assertReceiverIsOwner` enforces it in the SDK). Resolve token
addresses through `resolve_token`, which fails closed rather than accepting an
address the model produced. Keep a hard limit price so the order cannot fill
below what the agent reasoned about. Then run `validate_order` as a preflight.
For unattended signing, move those checks into code behind a Safe and an
EIP-1271 policy gate rather than trusting the agent to honour them.

### What does it cost an agent to swap?

Two things set the number, so it is worth being exact. On Optimism, Unichain,
and Robinhood Chain, the MCP and high-level SDK builders embed a 1 bp base; the
backend then retains 80% of reference-quote improvement on volatile pairs (99 bps
cap), or 50% on stable pairs (20 bps cap). CoW-hosted orders encode the same
Ophis base and capped improvement capture in appData; CoW Protocol's own fees
apply upstream. Use `buildOphisAppDataPartnerFee(chainId, isStablePair)` for the
complete partner fee, not a volume-only entry. Pool costs, price impact and gas
are additional. SDK v0.4.3 and hosted MCP include Arc, whose current
[release fee exception](https://docs.ophis.fi/fees) is a 1 bp volume fee without
backend improvement capture. Eligible settled Arc trades count toward referral
and volume-tier rebates; use SDK v0.4.4 or later for referral attribution.

Swap fees are deducted from the trade. Standard ERC-20 order signing and
submission are gasless, but approvals and other wallet transactions need gas.
Allowances may need renewal; bridge, native-deposit and vault flows differ.

### Which chains can an agent trade on?

SDK v0.4.3 and the hosted MCP server cover 14 EVM chains, including Arc. The swap
app separately offers Solana and Bitcoin destinations via NEAR Intents; bridge
coverage is route-specific. Do not hardcode endpoints: four of the EVM chains
(Optimism, Unichain, Robinhood Chain and Arc) are Ophis-operated and settle through
Ophis's own GPv2Settlement at a non-canonical address, so an order signed
against CoW's canonical domain will be rejected there. Resolve the settlement
domain and orderbook host per chain through `list_chains` or the SDK helpers and
that class of bug disappears.

## Start here

Ophis is the swap layer for the agent era: MEV-protected, self-custody, and
revenue-aligned with the people who integrate it.

- **MCP server:** [`https://mcp.ophis.fi/mcp`](https://mcp.ophis.fi/mcp)
- **AI agent docs:** [docs.ophis.fi/ai-agents](https://docs.ophis.fi/ai-agents)
- **SDK:** [`npm install @ophis/sdk`](https://www.npmjs.com/package/@ophis/sdk)
- **Try a swap:** [swap.ophis.fi](https://swap.ophis.fi/)
