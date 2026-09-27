# Public content audit — September 27, 2026

## Scope and release status

Reviewed `docs.ophis.fi` and `ophis.fi` against repository revision
`08739fc0837196d05e9634c707b14b68ec3b059a`, current primary documentation,
published package versions and selected read-only production checks.

The live crawl covered all **58 sitemap pages**: 19 documentation pages and
39 landing/blog pages. All returned HTTP 200. Advertised machine-readable
discovery files were also checked, including `llms.txt`, `llms-full.txt`, OpenAPI,
API discovery, authentication guidance and agent-skill discovery. The unadvertised
`/skill.md` probe returned 404; it is not a broken advertised entry point.

This report records the pre-release review on `fix/public-content-audit-20260927`.
The user subsequently authorized merging and publishing if checks pass; release
status must be confirmed from the associated PRs and deployment runs. No runtime
fee policy, contracts, trading backend, keys or customer configuration were changed.

This is a content/source consistency review, not a new independent security
audit, legal opinion or certification by Trail of Bits, Pashov or Semgrep.

## Findings corrected

| Finding | Correction |
| --- | --- |
| Vault documentation overstated spending and revocation guarantees | Documented the leaky-bucket bound (potentially almost twice capacity over a rolling day), pre-sign rather than fill-time oracle checks, persistent signatures/allowances after disable, and cancellation constraints. Updated the ABI example. |
| Arc was described as having the same improvement-fee policy as every operated chain | Added a dated Arc exception backed by the running configuration and a fulfilled order. Separated backend validation of declared fee entries from any supposed onchain minimum or absent-metadata guarantee. |
| Fee comparisons implied that a low base fee avoids AMM costs | Removed the misleading savings tables; explained pool costs, price impact, improvement capture, upstream fee ordering, bridge fees and gas. Rebate weights are not individual fee-refund percentages. |
| App coverage was conflated with SDK/parser support | Documented 14 app EVM networks versus 13 published SDK/MCP networks and parser slugs. Arc is app-supported but absent from those published integration helpers. |
| Recent networks, venues and asset features were missing | Added [Networks & assets](../../apps/docs-ophis/docs/networks-assets.md), covering Arc routing lanes, Ophis operator identity, Circle restrictions, staged WBTC/cirBTC conversion, bStocks/Reality attribution and the separate OTC flow. Linked it from both sites and discovery text. |
| Confidential and institutional features needed a clear release boundary | Distinguished keyed NEAR basic confidentiality and echo validation from a planned public selector. AML/SHIELD remains planned institutional, customer-gated work, not a released universal screening service. |
| Gaslessness, custody and MEV claims were overbroad | Qualified standard ERC-20 settlement versus approvals, native deposits, bridges, vaults and OTC. Removed universal attack-immunity and guaranteed-price claims. |
| Agent examples and discovery instructions had drifted | Corrected fee caps, tool counts, dependencies, skill install layout, parser-versus-executor scope, advisory entity offsets, soft-cancellation races and partial-fill handling. Updated skill manifest digests. |
| Browser-agent and example swap links could select the wrong route | Fixed WebMCP to derive supported slugs and numeric chain IDs from the canonical chain config; corrected the Optimism code example. Added stdlib and browser regression checks. |
| Comparison pages and old posts contained unsupported current claims | Replaced stale competitive rankings with sourced capability distinctions; qualified launch token-supply snapshots and current liquidity/eligibility requirements. Updated affected page dates, FAQ/schema copy and generated LLM documentation. |

## Arc fee evidence

- `infra/arc-mainnet/release/render.py` renders `[fee-policies] policies = []`.
- The production container `ophis-arc-autopilot-1` mounted the corresponding
  generated configuration with the same empty policy. Its file timestamp preceded
  the container's September 26 startup; image: `ophis-arc-backend:2bb9f9c78f52`.
- The [completed USDC/EURC order](https://arc-mainnet.ophis.fi/api/v1/orders/0xc32f04a27e91ea7da7395af79e4a1f74136d60c28c63e4cbd548e61cc6d886fa0494f503912c101bfd76b88e4f5d8a33de284d1a6ab53d7c)
  returned `fulfilled` and appData with `partnerFee.volumeBps: 1`, without an
  improvement entry. This establishes the checked order, not every possible Arc
  quote or future release. Users must still inspect current signed fee metadata.

## Verification

- Documentation: `pnpm build` and `pnpm typecheck` passed; 20 content pages,
  generated LLM text, broken-link/anchor enforcement and CSP injection.
- Landing: `pnpm build` and `pnpm typecheck` passed; 57 existing unit checks,
  the new WebMCP regression, 15 CSP tests, skill digests, chain-count validation
  and 173 FAQ answers matching visible text across 35 pages.
- Landing Playwright suite: **93 passed**, using this checkout's isolated preview
  on port 4397, not the unrelated development server on port 4321.
- Docs browser smoke: **10 passed** across five pages at desktop and mobile sizes;
  visible headings, feature boundaries, no body overflow or uncaught page errors.
  The mobile Networks & assets screenshot was also inspected.
- Built internal and cross-site links: **62 generated HTML pages, zero missing
  files or anchors**. This does not claim every external URL is healthy.
- Root network/docs, public-economics and agent-skills invariant checks passed.
- `git diff --check` passed. Package lockfiles and dependencies were unchanged.
- Landing typecheck reports 11 existing Astro schema deprecation hints, with
  zero errors/warnings in its summary. They are not new content regressions.
- Frontend and documentation QA reviewers checked the changes; final fee-table
  and rebate wording received a separate read-only review.

Temporary logs, crawl inventory and screenshots are in
`/tmp/ophis-public-content-audit.CyTR8i`; this directory is local evidence, not a
permanent public artifact. Ponytail kept the work to existing content surfaces
and a small stdlib regression; no redesign, dependency or new backend was added.
Browser checks reused the installed Node Playwright because Python Playwright
was unavailable.

## Open issue and limits

The live [Coinbase token metadata endpoint](https://swap.ophis.fi/api/base/tokenized-stocks)
returned **HTTP 502 on repeated checks**. The stock panel's existing unavailable
state is documented; present multipliers, pause states and supply could not be
verified through that endpoint. The cause was not diagnosed or fixed in this
content task. This must not be reported as an entirely green production service.

No funded swaps were executed on every chain. Every contract's deployed bytecode,
current issuer eligibility, live token liquidity, partner-key configuration and
OTC runtime write authorization were not independently revalidated. Documentation
now distinguishes source support, conditional configuration and live availability.
All sites must be rebuilt/deployed and rechecked publicly before these corrections
can be described as live.

Primary references used include [CoW fee policies](https://docs.cow.fi/governance/fees),
[NEAR confidential swaps](https://docs.near-intents.org/integration/distribution-channels/1click-api/quickstart/confidential-swaps),
[NEAR SHIELD](https://docs.near-intents.org/security-compliance/shield-incident-api),
[Base tokenized-stock disclosures](https://www.base.org/stocks), and
[Velora's current integration docs](https://docs.velora.xyz/docs).
