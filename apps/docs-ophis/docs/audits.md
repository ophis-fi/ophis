---
id: audits
title: Security & audits
description: Review Ophis wallet authorization, settlement contracts, governance and security reports.
sidebar_label: Security & audits
sidebar_position: 1
---

# Security & audits

Ophis uses wallet-authorized orders with onchain limits on the tokens, amounts, receiver and expiry.

## Wallet authorization {/* #custody */}

Standard ERC-20 swaps use EIP-712 signatures, ERC-1271 validation or onchain presigning. The settlement contract enforces your sell amount, applicable signed fee, receiver and minimum buy amount.

| Swap path | Funds and authorization |
| --- | --- |
| Standard ERC-20 | Funds stay in your wallet until an authorized solver settles the order. |
| Native-token | You deposit into EthFlow through an onchain order. |
| Bridge | Assets are deposited or burned before delivery; recovery follows the provider's rules. |
| NEAR Intents | You send a source-chain deposit and track delivery or refund through the saved transfer. |
| OTC | Trading uses external escrow. |
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

Ophis operates deployments of CoW Protocol's GPv2 settlement stack on these chains. The listed settlement, relayer and EthFlow contracts are immutable. The solver allowlist controls which addresses can settle orders.

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

Use each address on its listed chain. The [SDK deployment map](https://github.com/ophis-fi/ophis/blob/main/packages/sdk/src/domain.ts) and [Arc release sources](https://github.com/ophis-fi/ophis/tree/main/infra/arc-mainnet/release) contain deployment configuration. SDK v0.4.3 includes Arc signing and approval helpers; use ERC-20 token interfaces for Arc batch orders.

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

## Native ETH orders {/* #native-eth-sells-ethflow */}

You place native ETH sell orders through an onchain transaction to `CoWSwapEthFlow`, which is wired to the settlement contract and WETH. The transaction authorizes your limit price and receiver. After an unfilled order expires, you can reclaim its deposit directly from the contract onchain.

## Solver governance

The Optimism solver allowlist uses the following controls.

| Control | Rule |
| --- | --- |
| Solver additions and manager or implementation changes | A 24-hour TimelockController delays each change. |
| Timelock proposer and executor | A 2-of-3 Gnosis Safe with hardware-wallet signers. |
| Timelock administration | The timelock self-administers; the deployer's admin rights were renounced. |
| Solver removal | The multisig can evict a solver in a single transaction. |

| Contract | Address (Optimism) |
| --- | --- |
| Solver allowlist (`GPv2AllowListAuthentication`) | `0xAAA13bC6C1A505ccE6B4BF262fdDf4c703B9BD70` |
| TimelockController (24h) | `0x8fEe42897a0113BbeC86e4caCCaC5787D7AEC373` |

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

## Ophis source code {/* #ophis-specific-code */}

The [Ophis repository](https://github.com/ophis-fi/ophis) includes the swap frontend and developer Intent API.

| Component | Function |
| --- | --- |
| Frontend | A CoW Swap frontend fork with a token-picker swap form. |
| Intent-parser proxy | A Cloudflare Pages Function using LibertAI Qwen 3.6 27B with a server-side model key; see the [Intent API](/intent-api). |

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
