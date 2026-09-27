---
id: networks-assets
title: Networks, bridges & assets
description: Current app and SDK coverage, Arc bridges and venues, stock-provider labels, and the limits of confidential routing.
sidebar_label: Networks & assets
---

# Networks, bridges & assets

Reviewed September 27, 2026. A listed network or token is not a promise that
every pair has liquidity, that every wallet is eligible, or that a route will settle.
Check the live quote and the signing request.

## App, parser and SDK coverage

| Surface | Current scope |
| --- | --- |
| Swap app | 14 EVM networks, including Arc (5042); see [Getting started](./getting-started.md#supported-networks) |
| Published SDK, MCP and vault-order builder | 13 EVM networks; Arc is not yet included in their chain/domain helpers |
| Intent parser | 13 chain slugs, including `robinhood`, not `arc`; parsing does not verify a token contract or quote |
| NEAR destination selector | Solana, Bitcoin, Monad, Hyperliquid, X Layer, Sui and Tron; source/asset/provider availability still gates each route |

Ophis operates the orderbook and routing lanes on **Optimism, Unichain,
Robinhood Chain and Arc**. The other ten app networks use CoW-hosted orderbooks.
Do not send Arc orders to a guessed CoW endpoint or use another chain's signing domain.
Arc's app configuration is deployment-specific; the published SDK is not an Arc integration API.
Arc's current backend has no configured protocol improvement policy; see the
[fee-schedule exception](./fees.md#arc-release-exception), rather than assuming
all operated chains use identical fee handling.

## Arc and Circle bridges

Arc uses **USDC for gas**. Its native balance uses 18 decimals, while the
ERC-20 USDC interface used for token amounts and bridging uses 6.

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
Archery and Uniswap v4**. A lane identifies a liquidity route, not an independent
solver operator: Ophis-operated winners are labeled **Ophis**. Available pools,
pairs and lanes may change; no venue is promised on every chain or every trade.

Across and NEAR Intents remain separate providers for their supported routes.
An EVM network in the same-chain selector is not automatically an enabled bridge source.

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
