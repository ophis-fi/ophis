---
id: audits
title: Security & audits
description: Ophis is non-custodial, MEV-protected by construction, and built on unmodified CoW Protocol settlement contracts.
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
escrows, or takes possession of your tokens — you sign each order, and a
permissionless solver settles it on-chain.

## MEV protection by construction

Orders settle through a batch auction in which every trade clears at the
same uniform price. This eliminates the common MEV vectors structurally,
not as a best-effort mitigation:

- **No front-running** — there is no pending-order mempool race to win.
- **No sandwiching** — the protocol does not reorder trades for value.
- **No priority-gas auction** — execution order within a batch is not for
  sale.

## Smart contracts

Ophis uses **unmodified CoW Protocol settlement contracts** on Optimism
mainnet. Because the settlement layer is the original CoW Protocol code,
its existing audit history applies directly:

- CoW Protocol contract audits:
  [github.com/cowprotocol/contracts/tree/main/docs](https://github.com/cowprotocol/contracts/tree/main/docs)
- CoW Protocol documentation:
  [docs.cow.fi/cow-protocol](https://docs.cow.fi/cow-protocol)

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
