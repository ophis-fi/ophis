# Ophis

> Intent-based DEX aggregator. Describe a trade in plain English — Ophis resolves
> the tokens, chain, and amount, then routes it through a self-hosted
> [CoW Protocol](https://cow.fi) settlement stack.

**App:** [ophis.fi](https://ophis.fi) · **Docs:** [docs.ophis.fi](https://docs.ophis.fi) · **Explorer:** [explorer.ophis.fi](https://explorer.ophis.fi)

Ophis is a fork of CoW Protocol — orderbook, autopilot, driver, and baseline
solver — running under Ophis-controlled settlement contracts, fronted by a
rebranded CoW Swap UI with a natural-language intent layer. Orders are gasless,
MEV-protected, batch-settled limit orders; users pay a fee only on price
improvement (CIP-75 `priceImprovementBps`, capped by `maxVolumeBps`).

## Status

| Chain | Chain ID | Status |
|---|---|---|
| Optimism | 10 | **Live** — settlement, solver, partner fee |
| HyperEVM | 999 | Contracts deployed; stack paused |
| MegaETH | 4326 | Contracts deployed; stack paused |

Cross-chain destinations (Solana, Bitcoin) are surfaced via NEAR Intents.
Canonical contract addresses and the disclosure policy are in
[`SECURITY.md`](SECURITY.md).

## Architecture

| Path | Origin | Purpose |
|---|---|---|
| `apps/frontend/` | [`cowprotocol/cowswap`](https://github.com/cowprotocol/cowswap) (subtree) | Trading UI. Ophis-specific code lives under `apps/cowswap-frontend/src/ophis/` and `src/modules/mevReceipt/`. |
| `apps/backend/` | [`cowprotocol/services`](https://github.com/cowprotocol/services) (subtree) | Rust orderbook, autopilot, driver, baseline solver. |
| `contracts/` | [`cowprotocol/contracts`](https://github.com/cowprotocol/contracts) (subtree) | `GPv2Settlement`, `GPv2VaultRelayer`, `GPv2AllowListAuthentication` — deployed under an Ophis-controlled allowlist. |
| `apps/rebate-indexer/` | New | Volume-tier + fee-rebate API ([rebates.ophis.fi](https://rebates.ophis.fi)). |
| `apps/docs-ophis/` | New | Docusaurus docs portal (docs.ophis.fi). |
| `packages/sdk/` | New | [`@ophis/sdk`](packages/sdk) — partner-fee config, supported-chain registry, agent-safety helpers. |
| `functions/` | New | Cloudflare Pages Functions: the `/api/intent` natural-language parser + host routing. |
| `infra/` | New | Per-chain runtime stacks (`optimism-mainnet/`, `megaeth-mainnet/`, `hyperevm-mainnet/`, `local/`) plus shared RPC and Cloudflare config. |

Upstream subtrees are vendored as-is; Ophis changes are catalogued in
`apps/frontend/.ophis-divergences.md` and `apps/backend/.greg-divergences.md` so
`git subtree pull` stays tractable.

## Repo map

```
ophis/
├── apps/
│   ├── frontend/        CoW Swap fork (UI + Ophis intent layer)
│   ├── backend/         CoW Protocol services fork (Rust)
│   ├── rebate-indexer/  tier + rebate API
│   └── docs-ophis/      Docusaurus docs portal
├── contracts/           GPv2 settlement contracts (+ deployment artifacts)
├── packages/sdk/        @ophis/sdk
├── functions/           Cloudflare Pages Functions (intent API)
├── infra/               per-chain runtime stacks
└── docs/                specs, plans, audits, operations runbooks
```

## Build

```sh
pnpm install
pnpm build
```

`apps/frontend` and `apps/docs-ophis` are self-contained pnpm workspaces with
their own lockfiles, excluded from the root workspace — build them from inside
their own directories (see each app's README).

## Deploy

- **App** → Cloudflare Pages via [`.github/workflows/cloudflare-deploy.yml`](.github/workflows/cloudflare-deploy.yml) on every push to `main`.
- **Docs** → a separate Pages project via [`.github/workflows/docs-deploy.yml`](.github/workflows/docs-deploy.yml).
- **CI** (lint + typecheck + Slither + dependency/supply-chain scans) runs in [`.github/workflows/ci.yml`](.github/workflows/ci.yml) and [`security.yml`](.github/workflows/security.yml).

## Specs & plans

Authoritative design and per-phase plans live in
[`docs/development/`](docs/development/):

- [Design spec](docs/development/specs/2026-05-02-ophis-design.md) · [amendment](docs/development/specs/2026-05-03-ophis-design-amendment.md)
- [Phase plans](docs/development/plans/) and per-phase validation logs

## Security

See [`SECURITY.md`](SECURITY.md) for the disclosure policy, in-scope components,
and audit history.

## License

[GPL-3.0](LICENSE) — inherited from upstream CoW Protocol.
