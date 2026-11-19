<p align="center">
  <img src="apps/frontend/apps/cowswap-frontend/public/ophis-logo-full.svg" alt="Ophis" width="280" />
</p>

<h1 align="center">Ophis</h1>

<p align="center">Multichain swaps, cross-chain transfers and private trading.</p>

<p align="center">
  <a href="https://github.com/ophis-fi/ophis/actions/workflows/ci.yml?query=branch%3Amain"><img src="https://github.com/ophis-fi/ophis/actions/workflows/ci.yml/badge.svg?branch=main" alt="Core CI on main" /></a>
  <a href="https://github.com/ophis-fi/ophis/actions/workflows/frontend-ci.yml?query=branch%3Amain"><img src="https://github.com/ophis-fi/ophis/actions/workflows/frontend-ci.yml/badge.svg?branch=main" alt="Frontend checks on main" /></a>
  <a href="https://github.com/ophis-fi/ophis/actions/workflows/security.yml?query=branch%3Amain"><img src="https://github.com/ophis-fi/ophis/actions/workflows/security.yml/badge.svg?branch=main" alt="Dependency and security checks on main" /></a>
  <a href="https://docs.ophis.fi/networks-assets"><img src="https://img.shields.io/badge/networks-14_EVM_mainnets-7c3aed" alt="14 supported EVM mainnets" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-GPL--3.0-blue" alt="GPL-3.0 license" /></a>
</p>

<p align="center">
  <a href="https://swap.ophis.fi"><b>Swap</b></a> ·
  <a href="https://docs.ophis.fi"><b>Documentation</b></a> ·
  <a href="https://explorer.ophis.fi"><b>Explorer</b></a> ·
  <a href="CONTRIBUTING.md"><b>Contributing</b></a> ·
  <a href="SECURITY.md"><b>Security</b></a>
</p>

Ophis is a multichain DEX aggregator that brings token swaps, cross-chain
transfers and private trading into one interface. Users review quotes and
authorize trades in their wallets. Developers and agents can integrate through
the SDK, CLI or MCP server; the hosted MCP server does not hold private keys or
sign orders.

## Trading

- **Same-chain swaps:** signed batch-auction orders with solver-based execution
  and user-defined limits.
- **Cross-chain trading:** quotes and funding flows across supported bridge
  providers, including Relay. Availability depends on the asset and route.
- **Private swaps:** a separate RAILGUN flow with its own network coverage and
  funding requirements. See the [Privacy pools and private swaps guide](https://docs.ophis.fi/privacy-pools).

Standard ERC-20 orders retain funds in the wallet until settlement. Approvals,
native-token trades, bridges and private swaps can require onchain transactions
or deposits. The app shows the applicable quote and funding steps before signing.
See [network and funding coverage](https://docs.ophis.fi/networks-assets).

**Batch-auction fees:**
On every supported chain, Ophis charges a **0.01% (1 bp)** base fee, plus
80% of improvement over the reference quote on volatile pairs (99 bps cap),
or 50% on stable pairs (20 bps cap).
Hosted chains encode that policy in CIP-75 appData and separately pay
CoW Protocol's upstream fees. See the [fee guide](https://docs.ophis.fi/fees).

## Networks

The EVM order infrastructure supports **14 mainnets** across two settlement models:

| Settlement model                                                | Networks                                                                            |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| **Ophis-operated** orderbooks, solvers and settlement contracts | Optimism (10), Unichain (130), Robinhood Chain (4663), Arc (5042)                   |
| **CoW-hosted** settlement and solver network                    | Ethereum, BNB Chain, Gnosis, Polygon, Base, Plasma, Arbitrum, Avalanche, Ink, Linea |

The swap app also offers NEAR-powered routes to supported non-EVM networks.
Those deposit flows have separate asset, deadline and refund requirements.
Use the [network guide](https://docs.ophis.fi/networks-assets) for coverage and
[service status](https://docs.ophis.fi/status) for operational details.

## Integrate

| Interface          | Start here                                                                                                                                                 |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **TypeScript SDK** | Install `@ophis/sdk` for chain-specific orderbook URLs, signing domains, partner-fee appData and order validation. [SDK reference](packages/sdk/README.md) |
| **CLI**            | Run `npx @ophis/cli help` to explore wallet-connected quoting, swaps and bridges. [CLI guide](packages/cli/README.md)                                      |
| **MCP server**     | Connect a Streamable HTTP client to `https://mcp.ophis.fi/mcp`. [Tools and signing model](apps/mcp-server/README.md)                                       |
| **Intent API**     | Parse natural-language requests into structured intent data. [API reference](https://docs.ophis.fi/intent-api)                                             |

On Base, eligible public contract transactions from the swap app and CLI carry
Ophis builder code `bc_8j4gt5x6` using [ERC-8021 attribution](https://docs.base.org/specifications/builder-codes/overview).
Wallet batches request the optional attribution capability. Offchain order
signatures and CoW-hosted settlements are outside this client integration.
Ophis-operated solver settlements on Optimism, Robinhood Chain and Arc also
include cross-chain ERC-8021 tags. Recognition by Base's dashboard or rewards
program on these networks is unverified. See the
[backend rollout requirements](apps/backend/README.md#ophis-settlement-attribution).
See the [SDK integration notes](packages/sdk/README.md#base-builder-attribution).

For example, parse a request without submitting a trade:

```sh
curl -sS https://ophis.fi/api/intent \
  -H 'content-type: application/json' \
  -d '{"text":"swap 100 USDC for ETH on Base"}'
```

The Intent API parses text; the caller presents the result for review and handles
wallet authorization separately. See the [agent integration guide](https://docs.ophis.fi/ai-agents)
for signing policies and trust boundaries.

## Repository layout

| Path                                          | Contents                                                                                 |
| --------------------------------------------- | ---------------------------------------------------------------------------------------- |
| [`apps/frontend/`](apps/frontend)             | Swap app, Explorer and landing site; a separate pnpm workspace based on CoW Swap.        |
| [`apps/backend/`](apps/backend)               | Rust orderbook, autopilot, driver and solvers, based on CoW Protocol services.           |
| [`apps/mcp-server/`](apps/mcp-server)         | Hosted MCP integration.                                                                  |
| [`apps/business-console/`](apps/business-console) | Business onboarding, roles, approvals and partner reporting at pro.ophis.fi.          |
| [`apps/rebate-indexer/`](apps/rebate-indexer) | Trade indexing, referral attribution and rewards.                                        |
| [`apps/railgun/`](apps/railgun)               | Private-swap application and release documentation.                                      |
| [`apps/broadcaster/`](apps/broadcaster)       | Private transaction submission, prepaid gas credit and refunds.                          |
| [`apps/docs-ophis/`](apps/docs-ophis)         | Public documentation site.                                                               |
| [`packages/`](packages)                       | SDK, CLI, wallet-policy packages and integration adapters.                               |
| [`contracts/`](contracts)                     | Settlement contracts, deployment records and contract tests.                             |
| [`functions/`](functions)                     | Cloudflare Pages API endpoints and middleware.                                           |
| [`infra/`](infra)                             | Network deployments, RPC configuration and operational tooling.                          |
| [`docs/`](docs)                               | Architecture, development plans, operations and [review reports](docs/audits/README.md). |
| [`audit/`](audit)                             | Machine-readable scan baselines and verification data used by tooling.                   |

## Local development

Use Node.js 22 (at least 22.12) and the pnpm version pinned in
[`package.json`](package.json). Install Bun as well for the CLI tests included in
`pnpm test`. CI runs on Node.js 22.

```sh
git clone https://github.com/ophis-fi/ophis.git
cd ophis
corepack enable
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm test
```

The frontend and documentation site have independent pnpm workspaces and
lockfiles. Run their commands from their own directories:

```sh
# Swap app
cd apps/frontend
pnpm install --frozen-lockfile
pnpm run build:cowswap
```

```sh
# Documentation site, from the repository root
cd apps/docs-ophis
pnpm install --frozen-lockfile
pnpm run build
```

The backend uses Rust/Cargo; contracts use Foundry. Follow
[CONTRIBUTING.md](CONTRIBUTING.md) for component-specific setup, tests and review
requirements. The [release runbook](docs/operations/release-publishing.md) covers
package publishing; deployment workflows live in [`.github/workflows/`](.github/workflows).

## Security and contributions

Report vulnerabilities through the private channels in
[SECURITY.md](SECURITY.md). Historical reviews are collected in the
[review index](docs/audits/README.md), with their original scope and findings.

For changes, follow the [contribution guide](CONTRIBUTING.md), open a pull
request and complete the required checks. See [CHANGELOG.md](CHANGELOG.md) for
recorded releases.

## License

[GNU General Public License v3.0](LICENSE) at the repository root; component
licenses and upstream notices also apply. The SDK declares GPL-3.0-or-later,
the contracts LGPL-3.0-or-later and the frontend workspace ISC. Ophis includes code derived from
[CoW Swap](https://github.com/cowprotocol/cowswap),
[CoW Protocol services](https://github.com/cowprotocol/services) and
[CoW Protocol contracts](https://github.com/cowprotocol/contracts).
