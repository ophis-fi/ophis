---
id: intro
title: Introduction
description: Ophis is an intent-based DEX aggregator, describe a swap in natural language and a competitive solver auction fills it MEV-protected.
slug: /
sidebar_label: Introduction
sidebar_position: 1
---

# Ophis

**Ophis is an intent-based DEX aggregator.** You describe a swap in plain
English, _"swap 100 USDC for ETH on Base"_, and a competitive solver
auction fills it at the best price. The trade settles on-chain with
MEV protection built in, and you sign every order with your own wallet.

Ophis is a fork of [CoW Protocol](https://docs.cow.fi/cow-protocol)'s
frontend with an added natural-language intent-parsing layer. The full
source is at [github.com/ophis-fi/ophis](https://github.com/ophis-fi/ophis).

```
swap 100 USDC for ETH on Base
        │
        ▼  parse intent  →  sign order  →  solver auction  →  settle
```

## Core principles

- **Intent-based, not router-based.** You sign your _desired outcome_;
  solvers compete on _how_ to deliver it.
- **MEV-protected.** Orders settle through a batch auction where every
  trade clears at one uniform price. Sandwich attacks and front-running
  are structurally absent, not best-effort.
- **Self-custodial.** Ophis never holds funds. Every order is signed by
  your wallet (EIP-712 or ERC-1271) and executed by an authorized solver
  from the allowlisted solver set.
- **Flat, transparent fee.** A flat 0.10% (10 bps) Ophis fee on trade
  volume applies to every trade, 0.01% (1 bp) on same-chain stablecoin
  pairs. Example: swap 1,000 USDC and the Ophis fee is 0.10%, or 1 USDC.
  On the Ophis-operated chains (Optimism, Unichain) that is the all-in
  cost; on CoW-hosted chains [CoW Protocol's own fees apply on
  top](./fees.md).
- **Open.** The full frontend, intent-parser proxy, and infra runbooks
  are public.

## What's in these docs

| Section | What you'll find |
| --- | --- |
| [Getting started](./getting-started.md) | Make your first swap; how the three-step flow works; supported networks. |
| [How it works](./architecture.md) | Intent lifecycle, batch auctions, the parser proxy, and settlement. |
| [Fees & rebates](./fees.md) | The flat 0.10% (10 bps) fee model and how rebates accrue. |
| [Affiliate program](./affiliate.md) | Share a referral code, earn 8% of the net fee on every trade your referrals route. |
| [Intent API](./intent-api.md) | The public `POST /api/intent` endpoint, parse English into a structured order. |
| [AI agent integration](./ai-agents.md) | Wire the intent API into LangChain, AutoGPT, or your own agent. |
| [Security & audits](./audits.md) | Custody model, settlement contracts, and audit posture. |
| [FAQ](./faq.mdx) | Common questions about fees, networks, MEV, and custody. |

## Quick links

- **App:** [ophis.fi](https://ophis.fi)
- **Business portal:** [business.ophis.fi](https://business.ophis.fi)
- **Machine-readable summary:** [ophis.fi/llms.txt](https://ophis.fi/llms.txt)
- **OpenAPI spec:** [ophis.fi/openapi.json](https://ophis.fi/openapi.json)
- **Source:** [github.com/ophis-fi/ophis](https://github.com/ophis-fi/ophis)
