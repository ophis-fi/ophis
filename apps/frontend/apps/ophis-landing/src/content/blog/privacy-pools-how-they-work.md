---
title: "What Are Privacy Pools and How Do They Work?"
description: "Learn how crypto privacy pools make deposits and withdrawals harder to link, what stays public, and how 0xbow’s Privacy Pools differs from RAILGUN."
slug: "privacy-pools-how-they-work"
primaryKeyword: "privacy pools"
author: "Ophis"
pubDate: 2026-11-23
tags: [privacy-pools, privacy, zero-knowledge, railgun]
draft: false
cover: ./privacy-pools-how-they-work.cover.jpg
coverAlt: "Gold padlock above the Ophis emblem on a dark purple background."
---

A **privacy pool** is a shared smart contract that makes it harder to link a public deposit to a later withdrawal or spend. Your wallet can prove that it has the right to use funds in the pool without publishing which deposit funded the transaction. The deposit and any withdrawal to a public wallet are still visible onchain.

## How does a privacy pool work?

1. **Deposit.** You send tokens from a public wallet into the pool. Your wallet keeps a private record, often called a note, that lets it prove it can use the funds.
2. **Prove you can spend.** Your wallet creates a **zero-knowledge proof**, which lets the pool check that the spend is valid without identifying the original deposit. The pool also checks that the same funds have not already been spent.
3. **Spend or withdraw.** Some pools let you keep a private balance and transfer or swap supported assets. A withdrawal sends funds back to a public address, where the amount and destination are visible.

For example, if several wallets deposit USDC into the same pool, the proof can authorize a withdrawal without pointing to one of those deposits. If few deposits could plausibly match the withdrawal, the privacy benefit is smaller.

## What is Privacy Pools by 0xbow?

**Privacy Pools** is also the name of a protocol built by 0xbow. Its approach comes from a 2023 research paper that proposed letting users prove their funds came from a screened group of deposits without identifying their own deposit. In the app, 0xbow operates the **Association Set Provider**, which reviews deposits for eligibility to spend privately. [Original Privacy Pools research paper](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=4563364) · [0xbow’s Privacy Pools v2 overview](https://0xbow.io/blog/privacy-pools-v2-is-live)

Privacy Pools v2 adds private transfers, swaps and yield options for supported assets. If a deposit is awaiting approval or cannot be spent privately, the protocol offers a public exit called **ragequit**. That exit can recover the funds without the provider’s approval and exposes the note being recovered. [Privacy Pools v2 deposit guide](https://docs.privacypools.com/operations/deposit) · [Public exit documentation](https://docs.privacypools.com/operations/ragequit)

## How do Privacy Pools and RAILGUN compare?

| Protocol | What you can do | How deposit screening works |
| --- | --- | --- |
| 0xbow Privacy Pools v2 | Hold a private balance, transfer, swap or withdraw supported assets. | Private spending depends on approval from the Association Set Provider. |
| RAILGUN | Hold a shielded balance, transfer or swap through supported integrations, and withdraw to a public wallet. | Private Proofs of Innocence is an optional layer that wallets and services can apply. |

Ophis private mode uses **RAILGUN** on Ethereum, Arbitrum One and BNB Chain. RAILGUN holds the shielded assets, while supported Uniswap v3 pools provide liquidity for swaps. Depositing to the Ophis private wallet is a way to fund private activity. Liquidity provision and yield are separate services. [RAILGUN documentation](https://docs.railgun.org/wiki/assurance/private-proofs-of-innocence) · [Ophis private swap guide](https://docs.ophis.fi/privacy-pools/)

## What can people still see?

- **Public deposits and withdrawals.** The public addresses, assets, amounts and timing are visible. Those details can sometimes be matched even when the proof hides the direct link.
- **Public parts of a swap.** If an app uses a public exchange pool, the pool trade can be visible even when the trader’s shielded balance stays private.
- **App and network activity.** Services involved in sending the transaction may see network information such as your IP address. What each service sees depends on the app and route.

## FAQ

### Is a privacy pool the same as a mixer?

Both use shared deposits to make funds harder to trace between public addresses. A classic mixer generally focuses on deposits and withdrawals in fixed amounts. A shielded pool can support a private balance and actions such as transfers or swaps.

### Does Ophis use the 0xbow Privacy Pools protocol?

Ophis private mode uses RAILGUN shielded pools. See the [Ophis setup, funding and recovery guide](https://docs.ophis.fi/privacy-pools/) for supported networks and assets.

### Do privacy pools make transactions anonymous?

Privacy pools can hide the direct link to a deposit. Public amounts, timing and network information can still help someone infer a connection. The strength of that privacy depends on the pool and the app you use.
