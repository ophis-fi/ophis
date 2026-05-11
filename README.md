# Greg

> Codename — rebrand pending.

An intent-based DEX aggregator. Greg ships a self-hosted CoW Protocol orderbook,
solver, and driver runtime alongside a forked CoW Swap frontend, deployed on
multiple EVM chains under Greg-controlled settlement contracts.

## Status

- **Live (testnet):** four chains validated end-to-end at canonical Greg
  contract addresses — MegaETH (6343), HyperEVM (998, paused), Optimism Sepolia
  (11155420), Linea Sepolia (59141).
- **Public app:** [ophis.fi](https://ophis.fi) — frontend served via Cloudflare
  Pages (canonical Pages alias is still `greg-etm.pages.dev` until the project
  is renamed; see backlog item R2).
- **Mainnet deploy:** deferred to launch; gated on brand + domain.

## Architecture

| Path | Origin | Purpose |
|---|---|---|
| `apps/frontend/` | `cowprotocol/cowswap` (subtree) | Trading UI; Greg-rebranded shell. |
| `apps/backend/` | `cowprotocol/services` (subtree) | Rust orderbook, autopilot, driver, baseline solver. |
| `contracts/` | `cowprotocol/contracts` (subtree) | `GPv2Settlement`, `GPv2VaultRelayer`, `GPv2AllowListAuthentication`. Deployed unchanged under a Greg-controlled allowlist. |
| `packages/sdk/` | New | `@greg/sdk` — partner-fee defaults, supported-chain registry. |
| `infra/` | New | Per-chain configs + docker-compose stacks (`megaeth/`, `optimism/`, `linea/`, `hyperevm/`, `mantle/`, `katana/`, `local/`). |

## Repo map

```
greg/
├── apps/         frontend + backend (vendored upstreams)
├── contracts/    audited CoW Protocol contracts
├── infra/        per-chain runtime stacks
├── packages/sdk/ @greg/sdk
├── docs/development/  specs, plans, validation logs per phase
└── .github/workflows/ CI + Cloudflare Pages deploy
```

## Specs and plans

Authoritative design and per-phase plans live in
[`docs/development/`](docs/development/):

- [Design spec](docs/development/specs/2026-05-02-greg-design.md)
- [Spec amendment — strategic pivot](docs/development/specs/2026-05-03-greg-design-amendment.md)
- [Phase plans](docs/development/plans/) (foundation through fork-deploy)
- [Phase validation logs](docs/development/) (`phase-*-validation.md`)

## Build

```sh
pnpm install
pnpm build
```

Frontend deploys via [`cloudflare-deploy.yml`](.github/workflows/cloudflare-deploy.yml)
on every push to `main`. CI runs in [`ci.yml`](.github/workflows/ci.yml).

## License

[GPL-3.0](LICENSE) — inherits from upstream CoW Protocol.
