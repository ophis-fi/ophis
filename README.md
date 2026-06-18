<p align="center">
  <img src="apps/frontend/apps/cowswap-frontend/public/ophis-logo-full.svg" alt="Ophis" width="320"/>
</p>

<h1 align="center">Ophis</h1>

<p align="center">
  <b>Describe a trade in plain English. Ophis does the rest.</b><br/>
  An intent-based DEX aggregator with a natural-language layer, built for humans and agents alike.
</p>

<p align="center">
  <a href="https://github.com/ophis-fi/ophis/actions/workflows/ci.yml"><img src="https://github.com/ophis-fi/ophis/actions/workflows/ci.yml/badge.svg" alt="CI"/></a>
  <a href="https://github.com/ophis-fi/ophis/actions/workflows/codeql.yml"><img src="https://github.com/ophis-fi/ophis/actions/workflows/codeql.yml/badge.svg" alt="CodeQL"/></a>
  <a href="https://github.com/ophis-fi/ophis/actions/workflows/security.yml"><img src="https://github.com/ophis-fi/ophis/actions/workflows/security.yml/badge.svg" alt="Security audits"/></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-GPL--3.0-blue" alt="GPL-3.0 License"/></a>
  <a href="https://ophis.fi"><img src="https://img.shields.io/badge/Optimism-live-7c3aed" alt="OP mainnet live"/></a>
</p>

<p align="center">
  <a href="https://swap.ophis.fi"><b>Swap App</b></a> ·
  <a href="https://docs.ophis.fi"><b>Docs</b></a> ·
  <a href="https://explorer.ophis.fi"><b>Explorer</b></a> ·
  <a href="https://docs.ophis.fi/ai-agents"><b>Agents</b></a> ·
  <a href="packages/sdk"><b>SDK</b></a> ·
  <a href="SECURITY.md"><b>Security</b></a>
</p>

---

Say `swap 100 USDC for ETH on Base` and Ophis resolves the tokens, chain, and
amount, then fills the order through a competitive solver auction that settles
on-chain. It is a fork of [CoW Protocol](https://cow.fi) (orderbook, autopilot,
driver, and baseline solver) with a natural-language intent layer over a
rebranded CoW Swap UI. On Optimism, Ophis runs the whole stack under its own
settlement contracts and keeps the full fee; on the other supported chains
(Ethereum, Base, Arbitrum, and more) it routes through CoW Protocol's hosted
network.

What that buys you on every trade:

- **Gasless, MEV-protected.** Orders settle in a batch auction where every trade
  clears at one uniform price, so sandwiches and front-running are structurally
  absent, not best-effort.
- **Surplus stays with you.** Solvers compete to beat the price you signed, and
  any improvement is returned to you in full. Ophis takes a flat fee on volume
  and zero share of your surplus.
- **Non-custodial, no account, no auth.** Every order is signed in your own
  wallet (EIP-712 or ERC-1271). Ophis never holds keys or funds and cannot move,
  freeze, or recover them. The signature is the only trust boundary.
- **A flat, transparent fee.** 0.10% (10 bps) on volume, dropping to 0.01%
  (1 bp) on same-chain stablecoin pairs, with a share returned monthly as WETH
  rebates plus an 8% referral on trades you bring.

**Live across the CoW-supported chains**, with its own self-hosted settlement and
solver on Optimism (chain 10).

## Quickstart: the Intent API

Ophis's one bespoke API turns natural language into a structured order. No key,
no account, just POST your request:

```bash
curl -sS https://ophis.fi/api/intent \
  -H 'content-type: application/json' \
  -d '{"text":"swap 100 USDC for ETH on Base"}'
```

```json
{
  "ok": true,
  "data": {
    "intent": "swap",
    "entities": [
      { "type": "amount",    "value": "100",  "raw": "100",  "start": 5,  "end": 8 },
      { "type": "sellToken", "value": "USDC", "raw": "USDC", "start": 9,  "end": 13 },
      { "type": "buyToken",  "value": "ETH",  "raw": "ETH",  "start": 18, "end": 21 },
      { "type": "chain",     "value": "base", "raw": "Base", "start": 25, "end": 29 }
    ]
  }
}
```

Map the chain slug to a chain ID and hand the user a swap deep link to review and
sign. The endpoint only normalizes text, it never places, signs, or executes a
trade. It is rate-limited to 30 requests per minute per IP; non-browser callers
(no `Origin` header) are allowed, which is the path agents use. Full reference:
[docs.ophis.fi/intent-api](https://docs.ophis.fi/intent-api).

## Agents and SDK

Ophis is built to be traded by autonomous agents, not just people. Pick your
integration depth, all of it non-custodial and keyless:

### MCP server (recommended)

Point any MCP client (Claude, Cursor, a custom agent) at the hosted Model
Context Protocol server:

```
https://mcp.ophis.fi/mcp
```

It speaks Streamable-HTTP MCP and exposes six tools: `parse_intent`,
`get_quote`, `build_order`, `submit_order`, `lookup_tier`, and `list_chains`.
The server holds no keys and never signs. `build_order` returns a bounded,
ready-to-sign EIP-712 order with the receiver pinned to the owner; the agent
signs locally with its own key and submits. (A bare request without an
`Accept: text/event-stream` header returns HTTP 406, that is the transport
negotiating, not an outage.)

### @ophis/sdk

For agents that build and sign CoW orders directly:

```bash
npm install @ophis/sdk
```

The SDK encodes four fork details that fail **silently** if you guess them:

- **`getOphisOrderbookUrl(chainId)`** picks the right host. Optimism self-hosts
  its orderbook (not `api.cow.fi`); the wrong host bypasses the Ophis solver and
  zeroes the fee.
- **`getOphisOrderDomain(chainId)`** gives the EIP-712 domain with the correct
  `verifyingContract`. The OP settlement is non-canonical, so the cow-sdk default
  is rejected on-chain.
- **`buildOphisAppDataPartnerFee(chainId)`** builds the exact CIP-75 volume-fee
  fragment `{ volumeBps, recipient }`, not the price-improvement shape.
- **`assertReceiverIsOwner(owner, receiver)`** pins the order receiver. An
  unpinned receiver is the number one drain vector for an automated signer.

### Discovery and the trust boundary

Ophis publishes machine-readable manifests for agent discovery under
`https://ophis.fi/.well-known/`: `mcp.json`, `ai-plugin.json`, `agent-skills/`,
and `api-catalog` (RFC 9727), plus the root-served `auth.md`, `llms.txt`, and
`openapi.json`.

These off-chain helpers make the safe path the easy path, but they are guards,
not an authorization boundary: a prompt-injected agent can ignore them. For an
agent that signs **without a human in the loop**, enforce policy where the agent
cannot reach it: funds in a Safe smart account, a deterministic policy gate
(allowlisted tokens, pinned receiver and appData, an oracle-bounded limit price,
spend caps), a guardian key, and the same policy checked again at orderbook
ingestion. Full guide: [docs.ophis.fi/ai-agents](https://docs.ophis.fi/ai-agents).

## Status

Ophis settles across two kinds of chains.

**Ophis-operated** (self-hosted orderbook, solver, and settlement; Ophis keeps the
full fee):

| Chain | Chain ID | Status |
|---|---|---|
| Optimism | 10 | **Live**: settlement, solver, partner fee |
| HyperEVM | 999 | Contracts deployed, stack paused |
| MegaETH | 4326 | Contracts deployed, stack paused |

**CoW-hosted** (orders route through CoW Protocol's settlement and solver network,
with the partner fee disbursed by CoW): Ethereum, Base, Arbitrum, Polygon, BNB,
Gnosis, Avalanche, Linea, and the other CoW-supported chains, all live.

On **BNB Smart Chain (BSC, chain ID 56)** Ophis is live: orders placed through Ophis
(`SupportedChainId.BNB` in [`cowSdk.ts`](apps/frontend/apps/cowswap-frontend/src/cowSdk.ts),
mapped from the `bnb` slug in [`chainMap.ts`](apps/frontend/apps/cowswap-frontend/src/ophis/components/intent/chainMap.ts))
settle on-chain through CoW Protocol's GPv2Settlement at
`0x9008D19f58AAbD9eD0D60971565AA8510560ab41` on BSC, giving gasless, MEV-protected
swaps with no Ophis-side custody. Ophis does not deploy its own settlement on BSC;
BNB trades use CoW Protocol's canonical BSC deployment.

The two have different settlement contracts and orderbook hosts, so resolve them
per chain via `@ophis/sdk` or the MCP `list_chains` tool rather than assuming.
Full live status: [docs.ophis.fi/status](https://docs.ophis.fi/status).
Cross-chain destinations (Solana, Bitcoin) are surfaced via NEAR Intents.
Canonical contract addresses and the disclosure policy live in
[`SECURITY.md`](SECURITY.md).

## Architecture

| Path | Origin | Purpose |
|---|---|---|
| `apps/frontend/` | [`cowprotocol/cowswap`](https://github.com/cowprotocol/cowswap) (subtree) | Vite/Nx monorepo holding several surfaces: `apps/cowswap-frontend` is the swap UI (Ophis code under `src/ophis/` and `src/modules/mevReceipt/`), `apps/explorer` is the order explorer, `apps/ophis-landing` is the ophis.fi landing site. Self-contained pnpm workspace (own lockfile, excluded from the root). |
| `apps/backend/` | [`cowprotocol/services`](https://github.com/cowprotocol/services) (subtree) | Rust orderbook, autopilot, driver, baseline solver. Ophis additions live in dedicated crates and `ophis::` module paths. |
| `apps/mcp-server/` | New | `@ophis/mcp-server`: agent-facing MCP server (Streamable-HTTP) deployed as a Cloudflare Worker at `mcp.ophis.fi/mcp`. Holds no keys and never signs. |
| `apps/rebate-indexer/` | New | `@ophis/rebate-indexer`: off-chain volume-tier and WETH rebate indexer plus Safe batch proposer ([rebates.ophis.fi](https://rebates.ophis.fi)). |
| `apps/docs-ophis/` | New | Docusaurus docs portal ([docs.ophis.fi](https://docs.ophis.fi)). Self-contained app (own lockfile, excluded from the root, like `apps/frontend`). |
| `packages/sdk/` | New | [`@ophis/sdk`](packages/sdk): dependency-free helpers for the per-chain orderbook host, EIP-712 order domain, CIP-75 partner-fee `appData`, receiver-pinning guards, tier assignment, and the supported-chain registry. |
| `contracts/` | [`cowprotocol/contracts`](https://github.com/cowprotocol/contracts) (subtree) | `GPv2Settlement`, `GPv2VaultRelayer`, `GPv2AllowListAuthentication`, deployed under an Ophis-controlled solver allowlist. Per-network artifacts in `contracts/deployments/`. |
| `functions/` | New | Cloudflare Pages Functions: `api/intent.ts` (the natural-language parser, shared by swap and landing), `api/bungee` (bridge proxy), `_middleware.ts` (host routing). |
| `infra/` | New | Per-chain runtime stacks (`optimism-mainnet/`, `hyperevm-mainnet/`, `megaeth-mainnet/`, `local/`), plus `rpc/` (eRPC) and `cloudflare/` config. |

Upstream subtrees are vendored as-is; Ophis changes are catalogued in
`apps/frontend/.ophis-divergences.md` and `apps/backend/.ophis-divergences.md`
so `git subtree pull` stays tractable.

## Repo map

```
ophis/
├── apps/
│   ├── frontend/        cowswap fork: swap UI + explorer + landing site
│   ├── backend/         cowprotocol/services fork (Rust)
│   ├── rebate-indexer/  tier + WETH rebate API, Safe batch proposer
│   ├── docs-ophis/      Docusaurus docs portal
│   └── mcp-server/      agent-facing MCP Worker (mcp.ophis.fi)
├── contracts/           GPv2 settlement contracts (+ per-network deployments)
├── packages/sdk/        @ophis/sdk
├── functions/           Cloudflare Pages Functions (intent API, bungee, middleware)
├── infra/               per-chain runtime stacks + rpc + cloudflare config
├── scripts/             repo utility scripts
└── docs/                specs, plans, audits, operations runbooks
```

## Build

Root workspace (pnpm 9, Node 20.19+ or 22.12+, turborepo):

```sh
pnpm install      # all root-workspace deps
pnpm build        # builds members with a build step (currently @ophis/sdk)
pnpm typecheck    # typechecks every member
pnpm test         # runs the unit suites
```

Only `packages/sdk` has a build step today. `apps/rebate-indexer`,
`apps/mcp-server`, and `infra/rpc` run directly (no `build` script) and are
validated by `pnpm typecheck` and `pnpm test`. The Rust backend (`apps/backend`)
is a **Cargo** workspace, not a pnpm package, so build and test it with Cargo:

```sh
cd apps/backend && cargo build && cargo test
```

`apps/frontend` and `apps/docs-ophis` are self-contained pnpm workspaces with
their own lockfiles, deliberately excluded from the root. Build them from inside
their own directory (see each app's README):

```sh
cd apps/frontend   && pnpm install --frozen-lockfile && pnpm run build:cowswap
cd apps/docs-ophis && pnpm install --frozen-lockfile && pnpm run build
```

The contracts use Foundry (`forge build`); `forge-std` is a git submodule, so run
`git submodule update --init` first.

## Deploy

Every surface deploys independently from `main`:

- **Swap app and Explorer** [`cloudflare-deploy.yml`](.github/workflows/cloudflare-deploy.yml): two sequential Cloudflare Pages deploys (swap.ophis.fi / ophis.fi, then explorer.ophis.fi).
- **Landing** [`landing-deploy.yml`](.github/workflows/landing-deploy.yml): path-filtered build with a Playwright and Lighthouse budget gate, to Cloudflare Pages.
- **Docs** [`docs-deploy.yml`](.github/workflows/docs-deploy.yml): the Docusaurus site to its own Cloudflare Pages project.
- **MCP server** [`mcp-deploy.yml`](.github/workflows/mcp-deploy.yml): to Cloudflare Workers (custom domain `mcp.ophis.fi`) with a least-privilege Workers token.
- **Rebate indexer** [`rebate-indexer-deploy.yml`](.github/workflows/rebate-indexer-deploy.yml): to self-hosted infrastructure over a private network.
- **OP backend**: the live Optimism orderbook, autopilot, driver, and solvers run on self-hosted infrastructure via `docker compose` (defined under `infra/optimism-mainnet/`), exposed through a Cloudflare tunnel. Not a GitHub workflow.

Quality gates: [`ci.yml`](.github/workflows/ci.yml) (lint, typecheck, tests),
[`codeql.yml`](.github/workflows/codeql.yml),
[`security.yml`](.github/workflows/security.yml) (dependency and supply-chain
scans), and [`echidna.yml`](.github/workflows/echidna.yml) (contract fuzzing).
[`sdk-release.yml`](.github/workflows/sdk-release.yml) publishes `@ophis/sdk` to npm.

## Fees and rebates

Ophis charges the CoW Protocol CIP-75 volume policy: a flat **0.10% (10 bps)** of
trade volume, reduced to **0.01% (1 bp)** on same-chain stablecoin pairs, and
nothing on surplus. On Optimism the stack settles on its own infrastructure and
keeps the full fee; on CoW-hosted chains the partner share is disbursed weekly in
WETH.

Part of the fee flows back to traders:

- **Volume-tier rebates.** Each month a share of collected WETH fees is paid back,
  split across active wallets by 30-day volume and tier (Bronze through Platinum).
  The [rebate indexer](https://rebates.ophis.fi) computes shares and a Safe batch
  proposer pays out.
- **Referrals.** Mint a code, share `https://swap.ophis.fi/?ref=YOURCODE`, and earn
  8% of the net fee Ophis keeps on trades your referrals route, paid monthly in WETH.

Full numbers and the tier ladder: [docs.ophis.fi/fees](https://docs.ophis.fi/fees)
and [docs.ophis.fi/affiliate](https://docs.ophis.fi/affiliate).

## Security

See [`SECURITY.md`](SECURITY.md) for the disclosure policy, canonical contract
addresses, the partner-fee recipient and governance model, in-scope components,
and audit history.

## License

[GPL-3.0](LICENSE), inherited from upstream CoW Protocol.
