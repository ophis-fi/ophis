---
id: intro
title: Ophis DEX Aggregator Documentation
description: Ophis is an intent-based DEX aggregator across 14 EVM chains. Choose tokens, review your quote and spending limit, and sign with your wallet.
slug: /
sidebar_label: Introduction
sidebar_position: 1
---

# Ophis

**Ophis is an intent-based DEX aggregator.** Choose the tokens and amount,
review the quote and spending limit, and sign with your own wallet.
Solvers find a route that satisfies your signed order.

Ophis builds on [CoW Protocol](https://docs.cow.fi/cow-protocol).
The [Intent API](./intent-api.md) also supports natural-language requests
for developers and agents. The full source is at
[github.com/ophis-fi/ophis](https://github.com/ophis-fi/ophis).

```
Choose tokens and amount → review quote → sign order → settle
```

## Core principles

- **Intent-based, not router-based.** You sign your _desired outcome_;
  solvers compete on _how_ to deliver it.
- **MEV-protected by design.** Orders settle through a batch auction where
  trades clear at a uniform price per token pair, mitigating front-running and sandwiching.
  This is a mechanism-level defense, not an absolute guarantee against every
  adversarial condition.
- **Wallet-authorized.** Standard ERC-20 orders keep funds in your wallet until
  settlement. Native-token orders and bridge routes can require onchain deposits;
  their custody, gas and recovery rules differ. See [Security & audits](./audits.md).
- **Transparent, chain-aware fees.** The standard batch-auction policy charges a 1 bp base
  plus 80% of reference-quote improvement on volatile pairs (99 bps cap), or
  50% on stable pairs (20 bps cap). On CoW-hosted chains,
  [CoW Protocol's own fees apply on top](./fees.md). Arc applies the same capped backend improvement policy.
- **Open.** The full frontend, intent-parser proxy, and infra runbooks
  are public.

## What's in these docs

| Section | What you'll find |
| --- | --- |
| [Getting started](./getting-started.md) | Make your first swap; how the three-step flow works; supported networks. |
| [How it works](./architecture.md) | Intent lifecycle, batch auctions, the parser proxy, and settlement. |
| [Fees & rebates](./fees.md) | Standard pricing, hosted upstream fees and rebates. |
| [Networks & assets](./networks-assets.md) | App versus SDK coverage, Arc bridges, token labels and feature availability. |
| [Affiliate program](./affiliate.md) | Share a referral code, earn 8% of Ophis's verified base fee on eligible referred trades. |
| [Intent API](./intent-api.md) | The public `POST /api/intent` endpoint, parse English into a structured order. |
| [AI agent integration](./ai-agents.md) | Wire the intent API into LangChain, AutoGPT, or your own agent. |
| [Security & audits](./audits.md) | Custody model, settlement contracts, and audit posture. |
| [FAQ](./faq.mdx) | Common questions about fees, networks, MEV, and custody. |

## Quick links

- **App:** [swap.ophis.fi](https://swap.ophis.fi)
- **Business portal:** [business.ophis.fi](https://business.ophis.fi)
- **Machine-readable summary:** [ophis.fi/llms.txt](https://ophis.fi/llms.txt)
- **OpenAPI spec:** [ophis.fi/openapi.json](https://ophis.fi/openapi.json)
- **Source:** [github.com/ophis-fi/ophis](https://github.com/ophis-fi/ophis)
