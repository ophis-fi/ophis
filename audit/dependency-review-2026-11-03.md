# Dependabot sweep: 2026-11-03

## Decision

All 82 open Dependabot alerts were triaged one by one. 59 are fixed in this change by direct
bumps, bounded overrides, the zod 4 migration of `apps/rebate-indexer` and `cowswap-frontend`, and
the removal of an unused `servify` branch from `apps/railgun`. The 23 below stay open because no
patched release exists, the patch is an incompatible major on a third-party consumer, or the
patched code is already backported locally. Each one is unreachable from outside input in
production or covered by a local patch.

The zod GHSA-mrhx-c7xc-m3w5 exception in the root and frontend audit jobs is renewed to
**2026-12-03**. Its own code is now on zod 4 (rebate-indexer, cowswap-frontend, mcp-server).
The remaining 3.x copies belong to SDKs with no zod 4 release (`@coinbase/agentkit`,
`@goat-sdk/*`, `@reown/appkit-wallet`, `cdp-sdk`, `x402`, `privy`).

## Method

For each alert: installed versions and dependency paths from the lockfile, the vulnerable function
named from the advisory, call sites in our code and in the parent package, and the production
execution mode (Worker, Docker, static site, browser bundle; for railgun the real Rollup module
list). Each alert was then judged by TypeSafe Jev (`jev-latest`): `reachable` is the probability
that outside input reaches the vulnerable function in production, ignoring local patches;
`exposure` runs from 0 (not shipped) to 3 (called with outside input). Every fix and residual
claim was then checked by Jev against the post-fix lockfile, osv-scanner and test evidence. All
82 came back `supports`.

## Residuals

| Lockfile | Alert | Package | Advisory | Jev reachable / exposure | Why it stays open |
| --- | --- | --- | --- | --- | --- |
| root | #1139 | `minimatch` 3.1.5, 5.1.9 | GHSA-g3hv-75wg-m249 | 0.05 / 0.03 | No parent release uses minimatch >=11.0.1: eslint@latest 10.14.0 uses ^10.2.6, @eslint/eslintrc@latest uses ^3.1.5, readdir-glob@latest uses ^10.2.2. The vulnerable code needs an attacker-supplied glob pattern. Here the only patterns are developer-written eslint config globs and fixed testcontainers integration-test patterns, and both are dev-only. No prod dependency closure (rebate-indexer, mcp-server, cli, agentkit-ophis, plugin-goat) contains minimatch 3.1.5 or 5.1.9 |
| root | #1125 | `deepmerge` 4.3.1 | GHSA-gcqx-w48m-w2h4 | 0.16 / 1.86 | No patched release exists. The only caller is @cowprotocol/sdk-trading (buildAppData and mergeAppDataDoc), and it merges objects built by Ophis or SDK code (appDataDoc in packages/cli), never attacker JSON with __proto__ keys. The effect is limited to the returned object's prototype, and that object is then serialized from its own properties. It runs only on the client side: @ophis/cli on the user's machine and widget-react in the browser. No server prod closure contains deepmerge |
| root | #1076 | `zod` 3.22.4, 3.23.8, 3.25.76 | GHSA-mrhx-c7xc-m3w5 | 0.37 / 1.43 | No 3.x patch exists. The remaining zod 3 copies come from third-party SDKs that require zod 3: @coinbase/agentkit@0.10.4 (latest, dep ^3.23.8), @goat-sdk/core@0.5.0 (latest, peer ^3), @goat-sdk/wallet-evm (pins 3.23.8), @reown/appkit-wallet (3.22.4), cdp-sdk, privy and x402. All sit under the devDependencies of agentkit-ophis and plugin-goat. Those packages must share the host framework's zod 3 instance, so widening their peers to zod 4 would be incorrect. The peers stay at ^3.23.x. In mcp-server, zod 3.25.76 is reachable only through agents > @x402/core, which only the unused agents/x402 subpath imports; the dry-run Worker bundle's sourcemap contains only zod@4.6.7 sources. abitype and viem list zod only as an optional peer |
| frontend | #1133 | `minimatch` unchanged | GHSA-g3hv-75wg-m249 | 0.04 / 0.03 | 3.1.5 and 5.1.9 do not contain firstPhasePreProcess at all (checked in the tarballs). On 7.x-10.x it runs only when optimizationLevel>=2. Every consumer is lint/build/i18n/test tooling (eslint, @typescript-eslint, nx, @lingui/cli, sentry and rollup plugins, workbox) using patterns written in this repo. Ophis source never imports minimatch or glob, and nothing from them ships in the static Cloudflare Pages bundles. |
| frontend | #1132 | `glob` unchanged | GHSA-3g3m-2fjr-6pw4 | 0.03 / 0.03 | The flaw is that traversal continues after an AbortSignal cancel. I grepped every consumer (react-cosmos 7, @jest/reporters 30, @lingui/cli 5.5.1, @sentry/bundler-plugin-core 2.10/4.4) and none passes a signal option. All of them are build/test tooling walking the repo filesystem, and Ophis source does not import glob. |
| frontend | #1124 | `deepmerge` 4.3.1 | GHSA-gcqx-w48m-w2h4 | 0.4 / 2.07 | The only consumer is @cowprotocol/sdk-trading 2.0.2 (buildAppData and mergeAppDataDoc). It merges appData objects built in code, in the user's own browser. The flaw only changes the prototype of the returned object, not global Object.prototype, and that object is then serialized deterministically and keccak-hashed. Ophis calls mergeAppDataDoc only in a unit test. Jev scores exposure 2.07/3 because the function ships in the SPA, but reachable is only 0.40. |
| frontend | #1065 | `zod` 3.22.4, 3.23.8, 3.25.76 | GHSA-mrhx-c7xc-m3w5 | 0.75 / 2.82 | The 3.x copies come from packages we do not control: zod 3.22.4 is pinned by @reown/appkit-wallet (latest 1.8.24 still pins it), 3.25.76 by @coinbase/cdp-sdk (latest needs ^3.25.76) and @vercel/config (build config), plus the abitype peer for root viem; 3.23.8 comes via chromium-bidi <- @lhci/cli (landing CI only). No Ophis code calls these copies. Any out-of-memory would stay in the visitor's own tab: the app is a static SPA with no server-side zod. The osv-gate ignore is still required: without it the gate blocks on these 3 versions. |
| frontend | #1035 | `stream-json` 1.9.1 | GHSA-hqr4-qq8f-hg3x | 0.02 / 0 | This advisory is about the JSONC parser/verifier, and the stream-json 1.9.1 tarball has no jsonc/ directory. The only consumer is @bundle-stats/cli-utils, through rollup-plugin-bundle-stats in the bundle-analysis branch of vite.config.mts, and it parses our own build stats. Its latest release (4.23.1) still needs stream-json ^1.8.0 and the CommonJS stream-json/Assembler path, which 3.x dropped, so an upgrade is not compatible. |
| frontend | #1034 | `stream-json` 1.9.1 | GHSA-mjw6-4jj6-33hc | 0.03 / 0.03 | The match is on version only and the existing local patch covers this. Use is build-time only, on trusted stats JSON. |
| frontend | #980 | `stream-json` 1.9.1 | GHSA-528h-pc64-c93x | 0.04 / 0.04 | The match is on version only. The patch bounds the cost, and the vulnerable path filters are not used by the only (build-time) consumer. |
| railgun | #1134 | `decode-uri-component` 0.2.2 | GHSA-qr28-fpjm-wq7f | 0.13 / 0.44 | Not bundled. query-string decodes only in parse(), and its only importer, xhr-request, calls only stringify(). No CommonJS-compatible patched release exists. |
| railgun | #1129 | `@graphql-tools/executor-legacy-ws` 0.0.11 | GHSA-434m-5hcj-pxf3 | 0.08 / 0.72 | Bundled only because url-loader imports it statically. url-loader calls buildWSLegacyExecutor only when subscriptionsProtocol === 'LEGACY_WS', and every wallet 11.2.0 GraphqlHandler config sets only endpoint. The patched 1.1.36 is a new major line that requires @graphql-tools/utils 10, which is itself in the GHSA-7mx3 range. |
| railgun | #1128 | `@graphql-tools/executor-legacy-ws` 0.0.11 | GHSA-mp66-8ww2-pcwm | 0.1 / 0.78 | Bundled only because url-loader imports it statically. url-loader calls buildWSLegacyExecutor only when subscriptionsProtocol === 'LEGACY_WS', and every wallet 11.2.0 GraphqlHandler config sets only endpoint. The patched 1.1.36 is a new major line that requires @graphql-tools/utils 10, which is itself in the GHSA-7mx3 range. |
| railgun | #1112 | `zod` 3.22.4, 3.25.76 | GHSA-mrhx-c7xc-m3w5 | 0.13 / 0.77 | 3.25.76 is bundled through fets/zod-to-json-schema. The fets HTTP handler is the only code that validates request input with zod, and neither the app nor the Worker calls it. The app never imports zod. |
| railgun | #1109 | `@graphql-tools/executor-legacy-ws` 0.0.11 | GHSA-6fw5-9hq8-w87g | 0.08 / 0.81 | Mitigated by the existing TLS backport, and the legacy executor is never instantiated: url-loader builds it only for subscriptionsProtocol LEGACY_WS, which no wallet source config sets. The patched 1.1.35 is a new major line that requires @graphql-tools/utils 10, which is itself vulnerable. |
| railgun | #1108 | `@graphql-tools/utils` 8.13.1, 9.2.1 | GHSA-7mx3-vvmw-hjmv | 0.55 / 1.98 | The patched 12.0.1 is a major jump from the 8/9 lines that @graphql-mesh 0.93 and @envelop need. The shipped code carries the upstream fix as a backport, with CJS and ESM regression tests that pass. |
| railgun | #1107 | `@libp2p/peer-store` 11.2.7 | GHSA-vrf4-mx87-p53w | 0.78 / 2.09 | The patched 12.0.24 is a major jump from the 11.x line that libp2p 2.8.11 needs. The shipped code carries the backported identity check, and its regression test passes. |
| railgun | #1105 | `decode-uri-component` 0.2.2 | GHSA-vcc3-ghjq-m6fr | 0.13 / 0.47 | Not bundled. query-string decodes only in parse(), and its only importer, xhr-request, calls only stringify(). No CommonJS-compatible patched release exists. |
| railgun | #1089 | `elliptic` 6.6.1 | GHSA-848j-6mx2-7j84 | 0.58 / 1.78 | No upstream patched release exists. The bundled 6.6.1 is the patched build, and the P-521 leading-zero regression test passes. |
| railgun | #1087 | `web3-core-subscriptions` 1.10.4 | GHSA-hhf6-3xpg-pggx | 0.05 / 0.57 | Absent from the browser Rollup module list and the Worker. From web3 1.x, only web3-utils is bundled. |
| docs-ophis | #1131 | `minimatch` 3.1.5 | GHSA-g3hv-75wg-m249 | 0.03 / 0.06 | Patched line is minimatch 11.x (ESM, named export only); serve-handler calls the 3.x default-function API (require('minimatch')(path, pattern)). minimatch 3.1.5 contains zero occurrences of firstPhasePreProcess/secondPhasePreProcess (the vulnerable code from 10.2.6; GHSA range overmatches). Used only by `docusaurus serve` local preview with config patterns; production is a static Cloudflare Pages build. Moderate, docs gate (HIGH/CRITICAL) passes. |
| docs-ophis | #1123 | `deepmerge` 4.3.1 | GHSA-gcqx-w48m-w2h4 | 0.06 / 0.11 | No patched release (latest is 4.3.1). Sole dependent @svgr/plugin-svgo 8.1.0 declares but never requires it (dist/index.js requires only svgo and cosmiconfig); no docs-ophis source references it. Build-time only, static site. |
| contracts | #1137 | `minimatch` unchanged | GHSA-g3hv-75wg-m249 | 0.04 / 0.01 | Patched 11.x is an incompatible major for consumers pinned ^3/^5 (eslint 8, glob 7/8, mocha 10). Installed 3.1.5/5.1.9 lack firstPhasePreProcess/secondPhasePreProcess, asserted in CI by contracts/test/security-dependencies.cjs. Dev/test toolchain over repo-controlled globs only. Both fingerprints already in audit/contracts-osv-baseline.json (review due 2026-11-15). |

Rows with a high Jev `reachable` (libp2p, elliptic, graphql-tools/utils) ship code that carries
the upstream fix as a local backport in `apps/railgun/patches`, with regression tests. See
`apps/railgun/DEPENDENCIES.md`. The version-based alerts cannot see pnpm patches.

## Renewal criteria

Remove the zod exception when the listed SDKs ship zod 4, or re-review by 2026-12-03. Re-check
the railgun residuals after any Railgun SDK, Waku client or bundler change.
