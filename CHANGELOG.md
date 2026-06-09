# Changelog

All notable changes to Ophis are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project loosely follows [Semantic Versioning](https://semver.org) with
named phase tags for major milestones.

## [Unreleased]

### Changed
- Rebate pool resized from 50% to 21.25% of net WETH fees (`POOL_SPLIT_BPS` 5000 → 2125) so the protocol retains ~55% of gross blended after CoW's hosted-chain cut. Tier weights and the pari-mutuel distribution are unchanged; only the pool size shrinks.

### Security
- Bumped `shell-quote` to 1.8.4 (pnpm override) to resolve GHSA-w7jw-789q-3m8p (critical; transitive build-tool dep via `launch-editor`, not browser-reachable).
- Extended the tier-table cross-workspace invariant CI gate to cover the cowswap-frontend mirror (now all three), with numeric normalization so `0.5`/`0.50` and `5_000`/`5000` no longer cause a false mismatch.

### Added
- Issue + PR templates, `CODEOWNERS`, README badges, custom social preview ([#315]).
- Org-level profile README at [`ophis-fi/.github`](https://github.com/ophis-fi/.github).
- Bungee affiliate rev-share routing (sdk-bridging integration) ([#307]).
- All-chain partner-fee emission restored across the 14 served chains ([#306]).
- Cloudflare Turnstile activation on the `/contact` form (production-verified) ([#310] [#311] [#312]).
- Richer contact form with structured dropdowns + Telegram bridge + honeypot ([#308] [#309] [#310]).

### Changed
- Dependency security overrides closed 19 Dependabot alerts in one sweep; took
  the open-alert count from 202 to 0 via bumps + reasoned dismissals ([#314]).
  Notable: replaced a stale `tar: ^6.2.1` override that was forcing a vulnerable
  major; updates to `tmp`, `esbuild`, `protobufjs`, `rollup`, `yauzl`,
  `webpack-dev-server`, `on-headers`, `follow-redirects`, `svgo`, `minimatch`,
  `ip`, `@babel/plugin-transform-modules-systemjs`.
- Brand sweep: coral → saffron as the canonical primary; brand sheet font set to
  Geist ([#300] [#301] [#302] [#305]).
- Repo housekeeping: removed dead globe loader + `d3-geo`/`topojson-client`,
  retired the unused `EntityChip` component ([#303] [#304]).

### Fixed
- Formspree contact endpoint wired to the real public form ([#309]).
- Workflow comment drift in `cloudflare-deploy.yml` referencing a deleted
  `FORMSPREE_TURNSTILE_SECRET` ([#313]).

### Security
- Dismissed 169 alerts in `contracts/yarn.lock` + `contracts/pnpm-lock.yaml` as
  `not_used` — vendored hardhat toolchain is not installed by CI; production
  contracts build via `forge` (Foundry). Dismissed 7 unfixable runtime alerts
  with provably-bounded reachability rationale (`ip`, `elliptic`,
  `web3-core-method`, `web3-core-subscriptions`, `request`, `rand` x2). Audit
  trail per CVE recorded in dismissal comments.

## [0.2.5-phase2-5] — 2026-05-03

Phase 2.5 — Public Launch PASS (1 deferred item).

- Optimism mainnet is the live chain (settlement, solver, partner fee).
- HyperEVM (999) + MegaETH (4326) contracts deployed; backend stacks paused.
- Public docs portal at [docs.ophis.fi](https://docs.ophis.fi).
- Explorer at [explorer.ophis.fi](https://explorer.ophis.fi).
- SDK published as `@ophis/sdk` (partner-fee config, supported-chain registry,
  agent-safety helpers).

## [0.2-phase2] — 2026-05-03

Phase 2 — Retail Engineering Substrate PASS.

- Backend audit closed (32 → 3 deferred); rebate-indexer + partner-fee runtime
  hardened.
- Frontend audit closed; persisted-state hydration guards added.
- Cross-stack invariants enforced in CI (partner-fee, tier table, eRPC
  upstream-IDs).

## [0.1.5-phase1-5] — 2026-05-03

Phase 1.5 — Monetised Frontend PASS.

- CIP-75 `priceImprovementBps` partner fee shipped.
- Tier table + rebate ledger wired through to the frontend.

## [0.1-phase1] — 2026-05-03

Phase 1 — PARTIAL PASS.

- First end-to-end intent → quote → settlement loop on Optimism.
- Natural-language `/api/intent` parser shipped.

## [0.0-phase0] — 2026-05-02

Phase 0 foundation complete.

- Frontend deployed at `ophis.fi`.
- Backend build green; baseline solver operational.
- CoW Protocol subtrees vendored: `cowprotocol/cowswap`, `cowprotocol/services`,
  `cowprotocol/contracts`.

[#300]: https://github.com/ophis-fi/ophis/pull/300
[#301]: https://github.com/ophis-fi/ophis/pull/301
[#302]: https://github.com/ophis-fi/ophis/pull/302
[#303]: https://github.com/ophis-fi/ophis/pull/303
[#304]: https://github.com/ophis-fi/ophis/pull/304
[#305]: https://github.com/ophis-fi/ophis/pull/305
[#306]: https://github.com/ophis-fi/ophis/pull/306
[#307]: https://github.com/ophis-fi/ophis/pull/307
[#308]: https://github.com/ophis-fi/ophis/pull/308
[#309]: https://github.com/ophis-fi/ophis/pull/309
[#310]: https://github.com/ophis-fi/ophis/pull/310
[#311]: https://github.com/ophis-fi/ophis/pull/311
[#312]: https://github.com/ophis-fi/ophis/pull/312
[#313]: https://github.com/ophis-fi/ophis/pull/313
[#314]: https://github.com/ophis-fi/ophis/pull/314
[#315]: https://github.com/ophis-fi/ophis/pull/315

[Unreleased]: https://github.com/ophis-fi/ophis/compare/v0.2.5-phase2-5...HEAD
[0.2.5-phase2-5]: https://github.com/ophis-fi/ophis/releases/tag/v0.2.5-phase2-5
[0.2-phase2]: https://github.com/ophis-fi/ophis/releases/tag/v0.2-phase2
[0.1.5-phase1-5]: https://github.com/ophis-fi/ophis/releases/tag/v0.1.5-phase1-5
[0.1-phase1]: https://github.com/ophis-fi/ophis/releases/tag/v0.1-phase1
[0.0-phase0]: https://github.com/ophis-fi/ophis/releases/tag/v0.0-phase0
