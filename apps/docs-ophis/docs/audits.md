---
id: audits
title: Security & audits
description: Review Ophis wallet authorization, settlement contracts, governance and security reports.
sidebar_label: Security & audits
sidebar_position: 1
---

# Security & audits

Ophis public batch-auction orders use wallet authorization with onchain limits on the tokens, amounts, receiver and expiry. Direct transactions, private swaps and bridges use the separate authorization and custody paths below.

## Wallet authorization {/* #custody */}

Standard ERC-20 swaps use EIP-712 signatures, ERC-1271 validation or onchain presigning. The settlement contract enforces your sell amount, applicable signed fee, receiver and minimum buy amount.

| Swap path | Funds and authorization |
| --- | --- |
| Standard ERC-20 | Funds stay in your wallet until an authorized solver settles the order. |
| Native-token batch order | You deposit into EthFlow through an onchain order; direct routes may instead wrap or spend native currency in a wallet transaction. |
| Bridge | Assets are deposited or burned before delivery; recovery follows the provider's rules. |
| NEAR Intents | You send a source-chain deposit and track delivery or refund through the saved transfer. |
| OTC | Trading uses immutable Ethereum escrow; funds remain escrowed until filled or cancelled. |
| Private mode | A RAILGUN shielded wallet holds deposited assets and authorizes supported private transactions. |
| Private gas credit | Native-currency prepayments fund operator-held broadcaster credit, separate from shielded assets. Refunds depend on the operator's signing service and the refund policy below. |
| Vault | A policy module authorizes presigned orders for the Safe. |

<Steps>

1. **Review the wallet request.** Check the contract, approval, receiver and minimum amount before signing.
2. **Check NEAR deposit details.** Verify the asset, amount, destination, refund address, deadline and any memo before sending.
3. **Save your NEAR transfer.** Keep it for delivery or refund tracking.

</Steps>

## MEV protection {/* #mev-protection-by-construction */}

Batch auctions reduce common forms of MEV through these controls.

<Cards>
<Card icon="lock" title="Offchain submission">You submit an order offchain before settlement.</Card>
<Card icon="scale" title="Uniform prices">Orders in a batch use one clearing price per token pair.</Card>
<Card icon="shield-check" title="Signed limits">The settlement enforces your authorized amounts and receiver.</Card>
</Cards>

The winning settlement transaction's calldata can be visible in the public mempool. The contract enforces your signed limits when it executes.

## Smart contracts

Ophis operates the GPv2 settlement stack on the four networks below. The listed settlement, relayer and EthFlow contracts are immutable. The solver allowlist controls which addresses can settle orders.

| Contract | Address (Optimism, chain 10) | Function |
| --- | --- | --- |
| `GPv2Settlement` | `0x310784c7FCE12d578dA6f53460777bAc9718B859` | Settles orders. |
| `GPv2VaultRelayer` | `0x83847EaB41ad9ea43809ce71569eB2e9daF51830` | Honors calls from the settlement above. |
| `CoWSwapEthFlow` | `0x764fE4aa1FF493cf39931c7923C8ff5837596504` | Accepts native-ETH sell orders. |

| Contract | Address (Unichain, chain 130) | Function |
| --- | --- | --- |
| `GPv2Settlement` | `0x108A678716e5E1776036eF044CAB7064226F714E` | Settles orders. |
| `GPv2VaultRelayer` | `0xaB29E2a859704C914E55566Ae9b3A7EDE25959cb` | Honors calls from the settlement above. |
| `CoWSwapEthFlow` | `0x38C03729153BCCF6a281DaF41D7C6a14C543F1D7` | Accepts native-ETH sell orders. |

| Contract | Address (Robinhood Chain, chain 4663) | Function |
| --- | --- | --- |
| `GPv2Settlement` | [`0x886d9fd312F442C4E1f3cdeAE7b4AB73493e57cD`](https://robinhoodchain.blockscout.com/address/0x886d9fd312F442C4E1f3cdeAE7b4AB73493e57cD) | Settles orders. |
| `GPv2VaultRelayer` | `0xB52C38097c19cd38238c62DD36027a7918eFa890` | Honors calls from the settlement above. |
| `CoWSwapEthFlow` | `0xC1Ee77e8a1B85D5EED702a9bB435f434408A4d29` | Accepts native-ETH sell orders. |

| Contract | Address (Arc, chain 5042) | Function |
| --- | --- | --- |
| `GPv2Settlement` | `0x78799F98276efba1EdeeD32eae03a3fd8Cdfec3A` | Settles orders. |
| `GPv2VaultRelayer` | `0x895505F1FE6D762296685fF4a8201782FFdCB8E9` | Honors calls from the settlement above. |

Use each address on its listed chain. The [SDK deployment map](https://github.com/ophis-fi/ophis/blob/main/packages/sdk/src/domain.ts) and [Arc release sources](https://github.com/ophis-fi/ophis/tree/main/infra/arc-mainnet/release) contain deployment configuration. SDK v0.4.5 includes Arc signing and approval helpers; use ERC-20 token interfaces for Arc batch orders.

## Security reviews {/* #audit-methodology-and-tools */}

CoW Protocol publishes [contract audits](https://github.com/cowprotocol/contracts) and [protocol documentation](https://docs.cow.fi/cow-protocol) for the upstream settlement code.

Ophis internal security reviews cover the `GPv2AllowListAuthentication` two-step manager transfer and partner-fee settlement-buffer handling. Reports in [`audit/`](https://github.com/ophis-fi/ophis/tree/main/audit) and [`docs/audits/`](https://github.com/ophis-fi/ophis/tree/main/docs/audits) record each review's scope and results.

Ophis uses these tools and guides in its reviews:

<Cards>
<Card icon="search" title="Pashov skills" href="https://www.pashov.com/">Ophis uses threat models, invariants and differential-review workflows.</Card>
<Card icon="book-open" title="ETHSKILLS" href="https://ethskills.com">Ophis uses guidance for chain behavior, contract calls and signing.</Card>
<Card icon="code" title="Trail of Bits tools" href="https://www.trailofbits.com">Ophis uses Slither analysis, Echidna fuzzing and review checklists.</Card>
<Card icon="check" title="Verity Lang" href="https://veritylang.com">Ophis uses Lean 4 proofs for access-control models.</Card>
</Cards>

### Dependency status — 19 November 2026

[Dependabot](https://github.com/ophis-fi/ophis/security/dependabot) has three open high-severity alerts: broadcaster `zod` (#1144) and `@graphql-tools/utils` (#1143 and #1141). Tested local security backports are installed, but their upstream version numbers remain flagged. Migrating to compatible upstream fixed versions remains outstanding. This is not a claim of zero vulnerabilities or a complete audit.

Five picomatch alerts disappeared after [GHSA-fc5q-39xc-vjpf](https://github.com/advisories/GHSA-fc5q-39xc-vjpf) was withdrawn on 18 November; they were not closed by another release. Existing patches and regression checks remain. The [dependency review](https://github.com/ophis-fi/ophis/blob/main/docs/audits/dependency-review-2026-11-03.md) records the dated inventory, backports and scan limitations.

## Private wallet security

Private mode uses a separate RAILGUN wallet on Ethereum, Arbitrum and BNB Chain. Keep its recovery material secure. Public deposits and withdrawals remain visible onchain; shielding does not guarantee anonymity or hide every aspect of a pool swap. Only synchronized balances marked **Spendable** can fund a private transaction.

Review the minimum output, broadcaster identity, fee and any native-gas prepayment before authorizing. A pending transaction must be reconciled with the recovery controls before another spend. The public batch-auction solver allowlist and fee schedule do not govern this path.

Unused native-prepaid gas credit is **custodial**. Refunds require the operator's enabled signing service and sufficient backing; balances below the maximum processing allowance cannot produce a positive refund. There is no independent onchain withdrawal of this operator-held balance. These limits concern fee credit, not all shielded wallet assets. Follow [Privacy pools and private swaps](/privacy-pools) for wallet setup, deposits, fees, refunds and recovery. Read the [refund policy](https://github.com/ophis-fi/ophis/blob/main/apps/broadcaster/PREPAID-REFUNDS.md) and [private recovery instructions](https://github.com/ophis-fi/ophis/blob/main/apps/railgun/README.md#interrupted-transactions).

The production RPC allowlist enables Ethereum, BNB Chain and Arbitrum. Base remains a held pilot and Polygon is deferred; SDK configuration and local fork tests do not establish production availability. The current Ophis wallet and broadcaster disable PPOI checks; other RAILGUN wallets and services can enforce their own policies. Transaction proofs and synchronized spendable balances remain required. Private spending also depends on RPC access and transaction delivery. Public deposits, withdrawals and the pool swap remain visible. Ophis's gateway and Cloudflare can see the client's IP; the gateway's simulation upstream receives the signed batch without the original client-IP header.

The upstream settlement audits linked above concern the GPv2 contracts. They do not certify Ophis frontend changes, the private wallet, broadcasters, bridge providers or deployment configuration.

## Native ETH orders {/* #native-eth-sells-ethflow */}

For the EthFlow batch-auction path, you place native ETH sell orders through an onchain transaction to `CoWSwapEthFlow`, which is wired to the settlement contract and WETH. The transaction authorizes your limit price and receiver. After an unfilled order expires, you can reclaim its deposit directly from the contract onchain.

## Solver governance

Only authorized solvers can call the Ophis-operated settlement contracts. Immutable settlement code does not make this allowlist permissionless: its authenticator is upgradeable and its administrators can change solver access.

The following ownership, manager, timelock-delay and Safe-threshold reads were checked on **17 November 2026**. They are a dated configuration snapshot, not a full Safe-module or deployed-bytecode audit.

| Chain | Authenticator | Owner and manager controls | Checked block |
| --- | --- | --- | --- |
| Optimism (10) | `0xAAA13bC6C1A505ccE6B4BF262fdDf4c703B9BD70` | Owner: 24-hour timelock `0x8fEe42897a0113BbeC86e4caCCaC5787D7AEC373`. Manager: guardian `0x327F8894caEd538525c3956Fcd694b374B26B6fC`, controlled by the 2-of-3 Safe below. | 159667653 |
| Unichain (130) | `0x1002E12f2e7f848b20fe572F92133E467a5D010C` | Owner: 24-hour timelock `0xFC2A6a54122E6D0a598CAe7453DD61263c1065Ed`. Manager: guardian `0x4821A534FB11ea4bb2f88d48B13A498A80462e64`, controlled by the same 2-of-3 Safe. | 64185725 |
| Robinhood Chain (4663) | `0x5c802B14d9E132717aE78D42B19a4c517876F2E7` | Owner and manager: 2-of-3 Safe `0xe049a64546fb8564CC4c7D64A0A1BAe00Aa801cF`, with no intervening timelock. | 116730425 |
| Arc (5042) | `0xBA352C486B526886fDe4D15f3d3c9aC67Eca9d59` | Owner and manager: 2-of-3 Safe `0x858f0F5eE954846D47155F5203c04aF1819eCeF8`, with no intervening timelock. | 31742661 |

On Optimism and Unichain, Safe `0xe049a64546fb8564CC4c7D64A0A1BAe00Aa801cF` controls the timelock and guardian. Solver additions and manager or implementation changes go through the timelock; the guardian permits immediate solver removal. Robinhood Chain and Arc permit direct multisig administration. Neither a 24-hour delay nor a multisig alone establishes permissionless access or independent transaction inclusion.

## Key custody

| Key or account | Role |
| --- | --- |
| Protocol multisig | A 2-of-3 Gnosis Safe with hardware-wallet signers controls governance. |
| Partner-fee multisig | A 2-of-3 Gnosis Safe with hardware-wallet signers holds collected protocol fees separately from trader balances. |
| Partner-fee Safe address | `0x858f0F5eE954846D47155F5203c04aF1819eCeF8` |
| Operational solver keys | Sign settlement transactions within the order's limits. |

## Backend security {/* #infrastructure */}

| Control | Behavior |
| --- | --- |
| Network access | The backend sits behind Cloudflare; the public orderbook API is internet-facing and the settlement driver binds to loopback. |
| Signing key | A dedicated no-shell account isolates the key with restrictive permissions and renders it to RAM at runtime. |
| RPC consensus | The driver stops if its RPC sources disagree or are unavailable. |
| Frontend policies | Each app uses Content-Security-Policy headers; the swap app permits `unsafe-eval`, HTTPS connections and embedding for integrations. |
| Deployment | A branch-protected, SHA-pinned CI pipeline produces signed build provenance; the edge enforces HTTPS. |

The current backend source screens addresses against an OFAC SDN snapshot and manual bans. Its configured stale-snapshot policy stops order admission and auction delivery after 24 hours, rather than silently accepting unchecked addresses. The [screening runbook](https://github.com/ophis-fi/ophis/blob/main/docs/operations/ofac-address-screening.md) describes the implementation and rollout; this source review did not verify which binaries or screening configuration each production stack runs. Private services and external routes have separate policies. Holding your own signing keys does not guarantee access to a hosted API or solver.

## Business console

The [Business console](https://github.com/ophis-fi/ophis/tree/main/apps/business-console) at pro.ophis.fi is a separate permissioned service with invitations, company review, KYB records, sanctions screening and role-based approvals. Applications record the submitted company domain; operators review the company before enabling it. New applications allow synced passkeys, and an organisation can require hardware keys. These onboarding rules describe the Business console, not every public retail swap.

## Ophis source code {/* #ophis-specific-code */}

The [Ophis repository](https://github.com/ophis-fi/ophis) includes the swap frontend and developer Intent API.

| Component | Function |
| --- | --- |
| Frontend | Token selection, public and private swap modes, quote review and transaction tracking. |
| Intent-parser proxy | A Cloudflare Pages Function using LibertAI Qwen 3.6 27B with a server-side model key; see the [Intent API](/intent-api). |

Licensing varies by component: the root [LICENSE](https://github.com/ophis-fi/ophis/blob/main/LICENSE) is GPL-3.0, the SDK declares GPL-3.0-or-later, the contracts declare LGPL-3.0-or-later, and the frontend workspace declares ISC. Retain applicable component and upstream license notices; the root badge is not a complete dependency-license inventory.

## Report a vulnerability {/* #reporting-a-vulnerability */}

<Steps>

1. **Email the security contact.** Send the details to `clement@aleph.cloud` with the subject prefix `[OPHIS SECURITY]`.
2. **Follow the disclosure policy.** Read [`SECURITY.md`](https://github.com/ophis-fi/ophis/blob/main/SECURITY.md) for response targets and the full process.

</Steps>

For operator enquiries, use the [contact form](https://swap.ophis.fi/#/contact).

## Next

<Cards>
<Card icon="vault" title="Vault managers" href="/vault-managers">Set rules for rebalancing your Safe.</Card>
<Card icon="receipt" title="Fees" href="/fees">Read the swap fee schedule.</Card>
<Card icon="activity" title="Status" href="/status">Check live services and orderbooks.</Card>
</Cards>
