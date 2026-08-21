---
id: audits
title: Security & audits
description: Ophis is non-custodial and MEV-protected, settling through immutable CoW Protocol contracts, with governance via a 2-of-3 multisig and a 24-hour timelock.
sidebar_label: Security & audits
sidebar_position: 1
---

# Security & audits

:::note[TL;DR]

Ophis is non-custodial: no order moves without your wallet signature, and a solver
can never exceed your signed sell amount, receiver, or limit price. Trades settle
through immutable CoW Protocol contracts that have no admin, owner, or proxy, and
are MEV-protected by construction via uniform-price batch auctions. The only
mutable surface is the solver allowlist, governed by a 2-of-3 multisig behind a
24-hour timelock.

:::

Ophis is built so that the protocol **cannot move your funds without your
signature**, and so that execution is fair by construction rather than by
trust. This page describes the security measures in place. Every on-chain
property below is independently verifiable from the addresses listed.

## Custody

Ophis is **non-custodial**. The protocol cannot move user funds without an
EIP-712 (or ERC-1271) signature from your wallet. Ophis never holds, escrows,
or takes possession of your tokens: you sign each order, the order fixes the
sell token, sell amount, minimum buy amount (your limit price), receiver and
expiry, and an authorized solver settles it on-chain within exactly those
limits. A solver can never pull more than your signed sell amount, send the
proceeds anywhere but your signed receiver, or fill below your limit price.

## MEV protection by construction

Orders settle through a batch auction in which trades clear at a uniform price.
This is designed to mitigate common MEV vectors at the mechanism layer:

- **No front-running**: there is no pending-order mempool race to win.
- **No sandwiching**: the protocol does not reorder trades for value.
- **No priority-gas auction**: execution order within a batch is not for sale.

When the winning settlement transaction is broadcast, its calldata can be
visible in the public mempool like any transaction. The signed sell amount,
receiver, and limit price remain enforced by the settlement contract. Batch
settlement materially mitigates common MEV; it is not an absolute guarantee
against every adversarial or infrastructure condition.

## Smart contracts

Ophis runs its **own deployment** of CoW Protocol's GPv2 settlement stack on
Optimism, Unichain, and Robinhood Chain. The contracts that hold or move value are **immutable**: they have
no admin, no owner, and no proxy, so no operator (and no compromise of Ophis's
backend or frontend) can upgrade, pause, or re-point them:

| Contract | Address (Optimism) | Property |
| --- | --- | --- |
| `GPv2Settlement` | `0x310784c7FCE12d578dA6f53460777bAc9718B859` | Immutable, no admin/proxy |
| `GPv2VaultRelayer` | `0x83847EaB41ad9ea43809ce71569eB2e9daF51830` | Immutable, only ever honors the Settlement above |
| `CoWSwapEthFlow` | `0x764fE4aa1FF493cf39931c7923C8ff5837596504` | Immutable, native-ETH sells (see below) |

| Contract | Address (Unichain) | Property |
| --- | --- | --- |
| `GPv2Settlement` | `0x108A678716e5E1776036eF044CAB7064226F714E` | Immutable, no admin/proxy |
| `GPv2VaultRelayer` | `0xaB29E2a859704C914E55566Ae9b3A7EDE25959cb` | Immutable, only ever honors the Settlement above |
| `CoWSwapEthFlow` | `0x38C03729153BCCF6a281DaF41D7C6a14C543F1D7` | Immutable, native-ETH sells (see below) |

| Contract | Address (Robinhood Chain) | Property |
| --- | --- | --- |
| `GPv2Settlement` | `0x886d9fd312F442C4E1f3cdeAE7b4AB73493e57cD` | Immutable, no admin/proxy |
| `GPv2VaultRelayer` | `0xB52C38097c19cd38238c62DD36027a7918eFa890` | Immutable, only ever honors the Settlement above |
| `CoWSwapEthFlow` | `0xC1Ee77e8a1B85D5EED702a9bB435f434408A4d29` | Immutable, native-ETH sells (see below) |

The core settlement contract is CoW Protocol's audited code, so CoW's
settlement audits apply to it directly:

- CoW Protocol contract audits:
  [github.com/cowprotocol/contracts](https://github.com/cowprotocol/contracts)
- CoW Protocol documentation:
  [docs.cow.fi/cow-protocol](https://docs.cow.fi/cow-protocol)

Two pieces are **Ophis-specific** (not stock CoW) and were reviewed in Ophis's
own security audits: a hardened `GPv2AllowListAuthentication` (two-step manager
transfer) and the partner-fee settlement-buffer handling.

### Audit methodology and tools

Ophis used the following open-source security skills, guidance, analysis tools,
and formal-verification technology across applicable review scopes.

<div className="audit-tool-grid">
  <a className="audit-tool-card" href="https://www.pashov.com/">
    <span className="audit-tool-logo" aria-hidden="true">
      <img src="/logos/audit/pashov.svg" alt="" width="48" height="42" loading="lazy" />
    </span>
    <span>
      <strong>Pashov skills</strong>
      <small>Solidity audit-readiness, threat-model, invariant, and differential-review workflows.</small>
    </span>
  </a>
  <a className="audit-tool-card" href="https://ethskills.com">
    <span className="audit-tool-logo" aria-hidden="true">
      <img src="/logos/audit/ethskills.svg" alt="" width="48" height="42" loading="lazy" />
    </span>
    <span>
      <strong>ETHSKILLS</strong>
      <small>Ethereum guidance for chain semantics, RPC behavior, contract calls, and signing.</small>
    </span>
  </a>
  <a className="audit-tool-card" href="https://www.trailofbits.com">
    <span className="audit-tool-logo" aria-hidden="true">
      <img src="/logos/audit/trail-of-bits.svg" alt="" width="48" height="42" loading="lazy" />
    </span>
    <span>
      <strong>Trail of Bits</strong>
      <small>Slither static analysis, Echidna property fuzzing, and security-review checklists.</small>
    </span>
  </a>
  <a className="audit-tool-card" href="https://veritylang.com">
    <span className="audit-tool-logo" aria-hidden="true">
      <img src="/logos/audit/verity.svg" alt="" width="48" height="42" loading="lazy" />
    </span>
    <span>
      <strong>Verity Lang</strong>
      <small>Lean 4 machine-checked proofs for Ophis access-control models.</small>
    </span>
  </a>
</div>

Reproducible scope and results are recorded in the repository's
[`audit/`](https://github.com/ophis-fi/ophis/tree/main/audit) and
[`docs/audits/`](https://github.com/ophis-fi/ophis/tree/main/docs/audits)
reports. A tool or proof applies only to the scope named in its report; for
example, an access-control proof does not prove unrelated Rust or TypeScript
code.

### Native-ETH sells (EthFlow)

Selling native ETH is placed as an **on-chain order** to the immutable
`CoWSwapEthFlow` contract, which is constructor-wired to the Settlement and
WETH. These orders carry the same signed limit price and receiver as any other
order, and they are **refundable by you on-chain after the order expires**, so
even if no solver ever settles it, you reclaim your ETH directly from the
contract without trusting any operator.

## Solver governance

The only mutable on-chain surface is the **solver allowlist** (which addresses
are permitted to settle batches). It is governed conservatively:

- Adding a solver, or changing the allowlist's manager or implementation, flows
  through an on-chain **24-hour TimelockController**: every such change is
  publicly visible and delayed a full day before it can take effect.
- The timelock's proposer and executor is a **2-of-3 multisig** (Gnosis Safe,
  hardware-wallet signers); the deployer's admin rights were renounced and the
  timelock self-administers.
- A misbehaving solver can be **evicted in a single transaction** by the
  multisig: fast removal is allowed; only additions and upgrades are delayed.

| Contract | Address (Optimism) |
| --- | --- |
| Solver allowlist (`GPv2AllowListAuthentication`) | `0xAAA13bC6C1A505ccE6B4BF262fdDf4c703B9BD70` |
| TimelockController (24h) | `0x8fEe42897a0113BbeC86e4caCCaC5787D7AEC373` |

## Key custody

Authority is split and held in **multisigs, not single keys**:

- The **protocol multisig** and the **partner-fee multisig** are each a
  **2-of-3 Gnosis Safe** with hardware-wallet signers: no single key can move
  governance or fees.
- The only single-key components are non-custodial operational hot wallets (the
  solver that signs settlements carries a small gas float, never a treasury, and
  can only call `settle()` within your signed limits: it cannot drain wallets).

The partner-fee multisig (`0x858f0F5eE954846D47155F5203c04aF1819eCeF8`) holds
only collected protocol fees, kept entirely separate from trader funds, which
Ophis never custodies. See [Fees & rebates](./fees.md) for how the fee is
calculated.

## Infrastructure

- The trading backend is **self-hosted** behind Cloudflare; only the public
  orderbook API is internet-reachable, and the settlement driver is bound to
  loopback only.
- The settlement signing key is held under **OS-level isolation** (dedicated
  no-shell account, restrictive permissions, rendered to RAM at runtime), not in
  plaintext alongside the application.
- On-chain state is read through a **multi-source RPC consensus** layer that
  **fails closed**: if the sources disagree or are unavailable, the driver
  stops rather than acting on an unverified view.
- The frontends ship with a strict **Content-Security-Policy**, are deployed
  from a **branch-protected, SHA-pinned CI pipeline** with **signed build
  provenance**, and the edge enforces HTTPS.

## Ophis-specific code

The code unique to Ophis is open source and auditable end to end:

| Component | What it is |
| --- | --- |
| **Frontend** | A fork of the CoW Swap frontend with the natural-language intent layer. |
| **Intent-parser proxy** | A Cloudflare Pages Function in front of LibertAI Qwen 3.6 27B; the model key is held server-side. See the [Intent API](./intent-api.md). |
| **Rebate indexer** | Indexes the volume-tier rebates that accrue to traders. See [Fees & rebates](./fees.md). |

Source: [github.com/ophis-fi/ophis](https://github.com/ophis-fi/ophis).

## Reporting a vulnerability

Responsible disclosure is welcome. Email `clement@aleph.cloud` with the subject
prefix `[OPHIS SECURITY]`; see
[`SECURITY.md`](https://github.com/ophis-fi/ophis/blob/main/SECURITY.md) for the
full policy and response targets.

Operator contact: [contact form](https://swap.ophis.fi/#/contact).
