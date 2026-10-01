---
id: networks-assets
title: Networks, bridges & assets
description: Current app and SDK coverage, Arc bridges and venues, stock-provider labels, and the limits of confidential routing.
sidebar_label: Networks & assets
---

# Networks, bridges & assets

Reviewed October 1, 2026. A listed network or token is not a promise that
every pair has liquidity, that every wallet is eligible, or that a route will settle.
Check the live quote and the signing request.

## App, parser and SDK coverage

| Surface | Current scope |
| --- | --- |
| Swap app: batch-auction orders | 14 EVM networks, including Arc (5042); see [Getting started](./getting-started.md#supported-networks) |
| SDK v0.4.3 and hosted MCP | 14 EVM networks, including Arc (5042), with chain-specific orderbook and signing-domain helpers |
| Published vault-order builder | `@ophis/safe-swap` v0.1.7 uses SDK v0.4.4 and covers 14 EVM networks, including Arc, for ERC-20 presigned orders and referral attribution; this does not extend the on-chain policy-module rollout |
| Intent parser | 14 chain slugs, including `arc`; the swap app blocks chains disabled in its deployment. Parsing does not verify a token contract or quote |
| Standalone swap app: additional NEAR sources and destinations | Bitcoin, Solana, Monad, Hyperliquid (Hypercore), X Layer, Sui, Tron, Starknet and Zcash; source/asset/provider availability still gates each route. These are not additional CoW orderbook or SDK signing-domain deployments |

Ophis operates the orderbook and routing lanes on **Optimism, Unichain,
Robinhood Chain and Arc**. The other ten app networks use CoW-hosted orderbooks.
Do not send Arc orders to a guessed CoW endpoint or use another chain's signing domain.
Arc's app configuration is deployment-specific. SDK v0.4.3 resolves its orderbook to
`https://arc-mainnet.ophis.fi` and its EIP-712 settlement to
`0x78799F98276efba1EdeeD32eae03a3fd8Cdfec3A`. Arc settled trades are ingested by
the rebate indexer; use SDK v0.4.4 or later for referral metadata.
Arc applies the same capped backend market-order improvement policy as the
other operated chains; see the [fee schedule](./fees.md#arc-price-improvement-policy).

## Externally funded swaps through NEAR Intents

Use the same **You sell** and **You receive** network/token pickers in the
standalone swap app. Choosing a source outside the batch-auction network set
opens the externally funded flow automatically; a separate NEAR form is not required.
Supported balances can be sent **from or to** the additional networks above,
subject to the live asset catalogue and an executable quote. Source network names
can remain visible while the catalogue is unavailable; that does not make a token
or route available.

The direct flow's configured receiving networks also include Ethereum, Base,
Arbitrum, Optimism, Polygon, BNB, Avalanche, Gnosis, Plasma and Robinhood Chain.
This is a different coverage set from the 14 batch-auction chains. Arc uses the
Circle routes below; do not infer direct NEAR support for Arc, Unichain, Ink or Linea.

Review the source asset and exact amount, destination asset and minimum receive,
destination address, source-chain refund address and deposit deadline. Confirming
the quote creates a transfer record before funding instructions appear. Fund the
quoted deposit from your source wallet, including any required memo; a compatible
connected EVM wallet may offer a send action. External funding is an onchain
transfer, not a gasless EIP-712 batch order, and source gas or network fees can apply.
Keep the transfer record until delivery or refund is confirmed; the app provides
status tracking and transaction-reference recovery.

Zcash requires a mainnet transparent **t1/t3 address**; shielded and unified
addresses are not supported. Hyperliquid means **Hypercore spot balances**, not
Hyperliquid's EVM network. These flows require the NEAR provider to be enabled. Pausing new swaps
retains saved-transfer recovery in the standalone app. External-source selection
is not currently exposed by the embedded widget, Hooks view, SDK order builder
or hosted MCP tools.

## Arc and Circle bridges

Arc uses **USDC for gas**. Its native balance uses 18 decimals, while the
ERC-20 USDC interface used for token amounts and bridging uses 6.
Both interfaces access the same underlying balance; do not add them together.

The swap form includes Circle CCTP routes across the configured network set:
Arc, Ethereum, Base, Arbitrum, Optimism and Unichain. USDC uses CCTP; expanded
asset routes use Circle's token service and the configured per-chain registry.
Assets include EURC, cirBTC and WETH where both sides have a supported mapping.
This does not make every token in the picker bridgeable.

- The direct Circle flow requires an exact-input swap and a personal EOA wallet
  without smart-account code. It delivers to the connected wallet, not a custom recipient.
- **Ethereum WBTC → Arc cirBTC** is a separate two-stage flow: convert WBTC
  on Ethereum, then bridge cirBTC. It is not a native Bitcoin deposit or an atomic cross-chain swap.
- Approvals, conversion placement and bridge transactions can require gas.
  Review the quoted fees, minimum receive amount and destination gas needs.
- Source settlement does not prove destination delivery. Keep the pending
  transfer record and use the app's recovery flow if an attestation or mint is delayed.

Arc's configured Ophis routing lanes include **Uniswap v3, KyberSwap, Aero,
Archery, Uniswap v4 and SushiSwap v3**. A lane identifies a liquidity route, not an independent
solver operator: Ophis-operated winners are labeled **Ophis**. Available pools,
pairs and lanes may change; no venue is promised on every chain or every trade.

Across and NEAR Intents remain separate providers for their supported routes.
An EVM network in the same-chain selector is not automatically an enabled bridge source.
Optimism and Polygon Across source activation remains pending live execution
and delivery verification; Polygon also needs its helper deployed. Live assets
and quotes still gate each route. See the [Optimism deployment record](https://github.com/ophis-fi/ophis/blob/main/infra/optimism-mainnet/README.md#across-source-dependencies-october-1-2026)
for the mainnet dependencies and the separate fork-execution proof.

## Tokenized-asset labels

The picker carries provider labels for **Ondo, xStocks, Coinbase, bStocks and
Reality** when configured-list metadata attributes that chain/address to a provider.
The latest additions are **bStocks on BNB** and **Reality/rStock on Arbitrum**.
Their attribution comes from the configured CoinGecko lists and naming conventions,
not arbitrary wallet names, symbols or user-added list tags.

A badge is **display attribution**, not issuer authentication, a legal-rights
assessment, an AML decision, trading eligibility or a settlement guarantee.
Robinhood canonical-registry and multiplier checks are a separate feature;
they must not be inferred from a bStocks or Reality badge. Check the contract,
issuer disclosures, jurisdiction restrictions and executable liquidity independently.

## OTC is a separate Ethereum flow

The optional OTC desk uses external immutable escrow on **Ethereum**, not the
batch-auction orderbook. Public-mode support is restricted to reviewed WETH,
USDC and DAI and eligible standard EOAs; contract/delegated wallets and native
ETH are not supported. Create, fill, cancel and approval transactions cost gas.
Orders are public and all-or-nothing, with **no automatic onchain order expiry**.
A pending fill can race cancellation.

Writes require both a compatible frontend build and a fresh, matching runtime
authorization. A disabled switch prevents new prompts, not already-signed
transactions or existing escrow orders. Source support is not proof that live
writes are enabled. See the
[OTC operating guide](https://github.com/ophis-fi/ophis/blob/main/docs/development/otc-public-trading.md)
for admission, shutdown and uncertain-transaction recovery.

## Confidential routing and institutional features

With a configured partner key, Ophis's NEAR provider requests `confidentiality:
'basic'` and rejects a quote that does not echo the requested mode. Keyless
builds use public NEAR routes. This is provider-specific behavior, **not a
user-selectable all-route privacy guarantee**: Across, Circle and same-chain
orders do not inherit it, and external-chain transfers remain public.

A public confidentiality selector with route-wide enforcement remains planned.
The planned **AML + SHIELD institutional offer** is separate, customer-gated work;
it is not a released screening service for every swap. Neither a provider response
nor a badge proves compliance or anonymity. See NEAR's
[confidential-swap integration](https://docs.near-intents.org/integration/distribution-channels/1click-api/quickstart/confidential-swaps)
and [SHIELD incident API](https://docs.near-intents.org/security-compliance/shield-incident-api)
for the upstream capabilities, not a claim that all of them are integrated into Ophis.
