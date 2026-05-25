---
id: audits
title: Security & audits
description: Ophis is non-custodial and protects orders from MEV by construction, built on CoW Protocol's GPv2 settlement with Ophis-specific, separately-reviewed contracts.
sidebar_label: Security & audits
sidebar_position: 1
---

# Security & audits

Ophis is built so that the protocol **cannot move your funds without your
signature**, and so that execution is fair by construction rather than by
trust. This page describes the security posture.

## Custody

Ophis is **non-custodial**. The protocol cannot move user funds without an
EIP-712 (or ERC-1271) signature from the user's wallet. Ophis never holds,
escrows, or takes possession of your tokens — you sign each order, and an
authorized solver settles it on-chain.

## MEV protection by construction

Orders settle through a batch auction in which every trade clears at the
same uniform price. This eliminates the common MEV vectors structurally,
not as a best-effort mitigation:

- **No front-running** — there is no pending-order mempool race to win.
- **No sandwiching** — the protocol does not reorder trades for value.
- **No priority-gas auction** — execution order within a batch is not for
  sale.

One residual remains at the operational layer: when a solver broadcasts the
winning settlement transaction, its calldata is briefly visible in the public
mempool, which can enable gas-level MEV extraction against the *settlement*
itself. This neither reorders nor worsens your trade and carries no fund-loss
risk; a private submission path is on the roadmap.

## Smart contracts

Ophis is built on CoW Protocol's GPv2 settlement architecture. The core
**settlement contract** (`GPv2Settlement`) is CoW Protocol's code, unchanged —
so CoW's settlement audits apply to it directly:

- CoW Protocol contract audits:
  [github.com/cowprotocol/contracts/tree/main/docs](https://github.com/cowprotocol/contracts/tree/main/docs)
- CoW Protocol documentation:
  [docs.cow.fi/cow-protocol](https://docs.cow.fi/cow-protocol)

On Optimism, Ophis runs its **own deployment** of this stack — the settlement
at `0x310784c7…B859`, plus an Ophis-operated orderbook and solver. Two pieces
are **Ophis-specific** (not stock CoW) and were reviewed in Ophis's own security
audits:

- a hardened `GPv2AllowListAuthentication` — a two-step manager transfer guards
  control of the solver allowlist, and
- partner-fee settlement-buffer handling.

Upstream CoW audits cover only the unchanged upstream code; the Ophis-specific
contracts, deployment, and operations are covered by Ophis's own audit notes.

## Ophis-specific code

The code unique to Ophis is open source and auditable end to end:

| Component | What it is |
| --- | --- |
| **Frontend** | A fork of the CoW Swap frontend with the natural-language intent layer. |
| **Intent-parser proxy** | A Cloudflare Pages Function in front of LibertAI Qwen 3.6 27B; the model key is held server-side. See the [Intent API](./intent-api.md). |
| **Rebate indexer** | Indexes the positive-slippage rebates that accrue to traders. See [Fees & rebates](./fees.md). |

Source: [github.com/ophis-fi/ophis](https://github.com/ophis-fi/ophis).

## Fee custody

Partner fees accrue to a Gnosis Safe multisig (`0x858f…CeF8`), deployed
deterministically (CREATE2) to the **same address on every supported
chain**. Fees are routed to the Safe weekly. See
[Fees & rebates](./fees.md) for how the fee is calculated.

## Contact

Operator contact: [contact@3615crypto.com](mailto:contact@3615crypto.com).
For source, issues, and the full infrastructure runbooks, see
[github.com/ophis-fi/ophis](https://github.com/ophis-fi/ophis).
