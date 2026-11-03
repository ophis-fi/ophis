# Dependabot sweep: 2026-11-03

## Decision

All 82 open Dependabot alerts were triaged one by one. **69 are fixed**: the vulnerable versions
are gone from the lockfiles, through direct bumps, bounded overrides, the zod 4 migration of
`apps/rebate-indexer` and `cowswap-frontend`, and the removal of dead dependency trees (railgun's
unused `servify` and `web3` 1.x branches, the frontend's opt-in `rollup-plugin-bundle-stats`).

**13 stay flagged** because Dependabot and osv-scanner match by version and cannot see a pnpm patch
or read the code:

- 9 are **patched locally** with regression tests: deepmerge 4.3.1 (root, frontend, docs; nothing in docs requires it, so the docs patch is defence in depth) and the
  third-party zod 3.x copies (root, frontend, railgun) by new backports in `patches/`; railgun's
  `@graphql-tools/utils` 8/9, `@libp2p/peer-store` 11 and `elliptic` by existing backports.
- 4 are minimatch, where the advisory range `<11.0.1` is broader than the code: 3.1.5 and 5.1.9
  do not contain the vulnerable preprocessing, and the frontend's remaining 10.2.5 serves nx's
  `makeRe` (removed in 11) with repository-written patterns.

After merge these 13 are dismissed on GitHub with this document as the evidence. The zod
GHSA-mrhx-c7xc-m3w5 exception in the root and frontend audit jobs stays (osv cannot see the
backport) and is renewed to **2026-12-03**.

## Method

For each alert: installed versions and dependency paths from the lockfile, the vulnerable function
named from the advisory, call sites in our code and in the parent package, and the production
execution mode (Worker, Docker, static site, browser bundle; for railgun the real Rollup module
list). Each alert was then judged by TypeSafe Jev (`jev-latest`): `reachable` is the probability
that outside input reaches the vulnerable function in production, ignoring local patches;
`exposure` runs from 0 (not shipped) to 3 (called with outside input). Every fix and residual
claim was then checked by Jev against the post-fix lockfile, osv-scanner and test evidence. All
82 came back `supports`.

## Still flagged (13)

| Lockfile | Alert | Package | Advisory | Jev reachable / exposure | Why it stays open |
| --- | --- | --- | --- | --- | --- |
| root | #1139 | `minimatch` 3.1.5, 5.1.9 | GHSA-g3hv-75wg-m249 | 0.05 / 0.03 | No parent release uses minimatch >=11.0.1: eslint@latest 10.14.0 uses ^10.2.6, @eslint/eslintrc@latest uses ^3.1.5, readdir-glob@latest uses ^10.2.2. The vulnerable code needs an attacker-supplied glob pattern. Here the only patterns are developer-written eslint config globs and fixed testcontainers integration-test patterns, and both are dev-only. No prod dependency closure (rebate-indexer, mcp-server, cli, agentkit-ophis, plugin-goat) contains minimatch 3.1.5 or 5.1.9 |
| root | #1125 | `deepmerge` 4.3.1 | GHSA-gcqx-w48m-w2h4 | 0.16 / 1.86 | **Patched locally:** `patches/deepmerge@4.3.1.patch` makes `propertyIsUnsafe` reject `__proto__`, `constructor` and `prototype` and applies it to both `mergeObject` loops (dist/cjs.js, dist/umd.js); ordinary merges are unchanged (`scripts/test-deepmerge-security.cjs`). No upstream release exists. The only caller is @cowprotocol/sdk-trading (buildAppData and mergeAppDataDoc), and it merges objects built by Ophis or SDK code (appDataDoc in packages/cli), never attacker JSON with __proto__ keys. The effect is limited to the returned object's prototype, and that object is then serialized from its own properties. It runs only on the client side: @ophis/cli on the user's machine and widget-react in the browser. The pnpm patch reaches repo builds only; the published @ophis/cli bundles deepmerge at build time, so 0.1.6 on npm is unpatched until the CLI is rebuilt and republished (0.1.7). No server prod closure contains deepmerge |
| root | #1076 | `zod` 3.22.4, 3.23.8, 3.25.76 | GHSA-mrhx-c7xc-m3w5 | 0.37 / 1.43 | **Patched locally:** `patches/zod@3.*.patch` backport zod 4.6.6's fix (a0ebf97): an array or set over its maximum fails with its usual issue before any element is parsed; within limits nothing changes (`scripts/test-zod3-security.cjs`; railgun: `tests/dependencies.test.mjs`). The 3.25.76 patch covers the default v3 export; no consumer imports its `zod/v4` subpath. No upstream 3.x release has the fix. The remaining zod 3 copies come from third-party SDKs that require zod 3: @coinbase/agentkit@0.10.4 (latest, dep ^3.23.8), @goat-sdk/core@0.5.0 (latest, peer ^3), @goat-sdk/wallet-evm (pins 3.23.8), @reown/appkit-wallet (3.22.4), cdp-sdk, privy and x402. All sit under the devDependencies of agentkit-ophis and plugin-goat. Those packages must share the host framework's zod 3 instance, so widening their peers to zod 4 would be incorrect. The peers stay at ^3.23.x. In mcp-server, zod 3.25.76 is reachable only through agents > @x402/core, which only the unused agents/x402 subpath imports; the dry-run Worker bundle's sourcemap contains only zod@4.6.7 sources. abitype and viem list zod only as an optional peer |
| frontend | #1133 | `minimatch` 3.1.5, 5.1.9, 10.2.5 | GHSA-g3hv-75wg-m249 | 0.04 / 0.03 | 9.0.9 and 10.2.6 moved to 11.0.4 with parent-scoped overrides (`@swc/cli`, `@typescript-eslint/typescript-estree`, `@vue/language-core`). 10.2.5 stays for nx 22.7.10, which calls `minimatch.makeRe()` (removed in 11), with repository-written patterns in dev tooling only. 3.1.5 and 5.1.9 (^3/^5 consumers) do not contain the vulnerable `firstPhasePreProcess`. |
| frontend | #1124 | `deepmerge` 4.3.1 | GHSA-gcqx-w48m-w2h4 | 0.4 / 2.07 | **Patched locally:** `patches/deepmerge@4.3.1.patch` makes `propertyIsUnsafe` reject `__proto__`, `constructor` and `prototype` and applies it to both `mergeObject` loops (dist/cjs.js, dist/umd.js); ordinary merges are unchanged (`scripts/test-deepmerge-security.cjs`). No upstream release exists. The runtime consumer is @cowprotocol/sdk-trading 2.0.2: buildAppData and mergeAppDataDoc merge appData objects built in code, in the user's own browser. The other consumers (@rollup/plugin-node-resolve, @svgr/plugin-svgo, fork-ts-checker-webpack-plugin, jest-config) merge developer-written build and test config. The flaw only changes the prototype of the returned object, not global Object.prototype, and that object is then serialized deterministically and keccak-hashed. Jev scores exposure 2.07/3 because the function ships in the SPA, but reachable is only 0.40. |
| frontend | #1065 | `zod` 3.22.4, 3.23.8, 3.25.76 | GHSA-mrhx-c7xc-m3w5 | 0.75 / 2.82 | **Patched locally:** `patches/zod@3.*.patch` backport zod 4.6.6's fix (a0ebf97): an array or set over its maximum fails with its usual issue before any element is parsed; within limits nothing changes (`scripts/test-zod3-security.cjs`; railgun: `tests/dependencies.test.mjs`). The 3.25.76 patch covers the default v3 export; no consumer imports its `zod/v4` subpath. The 3.x copies come from packages we do not control: zod 3.22.4 is pinned by @reown/appkit-wallet (latest 1.8.24 still pins it), 3.25.76 by @coinbase/cdp-sdk (latest needs ^3.25.76) and @vercel/config (build config), plus the abitype peer for root viem; 3.23.8 comes via chromium-bidi <- @lhci/cli (landing CI only). No Ophis code calls these copies. Any out-of-memory would stay in the visitor's own tab: the app is a static SPA with no server-side zod. The osv-gate ignore is still required: without it the gate blocks on these 3 versions. |
| railgun | #1112 | `zod` 3.22.4, 3.25.76 | GHSA-mrhx-c7xc-m3w5 | 0.13 / 0.77 | **Patched locally:** `patches/zod@3.*.patch` backport zod 4.6.6's fix (a0ebf97): an array or set over its maximum fails with its usual issue before any element is parsed; within limits nothing changes (`scripts/test-zod3-security.cjs`; railgun: `tests/dependencies.test.mjs`). The 3.25.76 patch covers the default v3 export; no consumer imports its `zod/v4` subpath. 3.25.76 is bundled through fets/zod-to-json-schema. The fets HTTP handler is the only code that validates request input with zod, and neither the app nor the Worker calls it. The app never imports zod. |
| railgun | #1108 | `@graphql-tools/utils` 8.13.1, 9.2.1 | GHSA-7mx3-vvmw-hjmv | 0.55 / 1.98 | The patched 12.0.1 is a major jump from the 8/9 lines that @graphql-mesh 0.93 and @envelop need. The shipped code carries the upstream fix as a backport, with CJS and ESM regression tests that pass. |
| railgun | #1107 | `@libp2p/peer-store` 11.2.7 | GHSA-vrf4-mx87-p53w | 0.78 / 2.09 | The patched 12.0.24 is a major jump from the 11.x line that libp2p 2.8.11 needs. The shipped code carries the backported identity check, and its regression test passes. |
| railgun | #1089 | `elliptic` 6.6.1 | GHSA-848j-6mx2-7j84 | 0.58 / 1.78 | No upstream patched release exists. The bundled 6.6.1 is the patched build, and the P-521 leading-zero regression test passes. |
| docs-ophis | #1131 | `minimatch` 3.1.5 | GHSA-g3hv-75wg-m249 | 0.03 / 0.06 | Patched line is minimatch 11.x (named exports only); serve-handler calls the 3.x default-function API (require('minimatch')(path, pattern)). minimatch 3.1.5 contains zero occurrences of firstPhasePreProcess/secondPhasePreProcess (the vulnerable code from 10.2.6; GHSA range overmatches). Used only by `docusaurus serve` local preview with config patterns; production is a static Cloudflare Pages build. Moderate, docs gate (HIGH/CRITICAL) passes. |
| docs-ophis | #1123 | `deepmerge` 4.3.1 | GHSA-gcqx-w48m-w2h4 | 0.06 / 0.11 | **Patched locally:** `patches/deepmerge@4.3.1.patch` makes `propertyIsUnsafe` reject `__proto__`, `constructor` and `prototype` and applies it to both `mergeObject` loops (dist/cjs.js, dist/umd.js); ordinary merges are unchanged; the docs copy is tested in docs-deploy on main pushes (`scripts/test-deepmerge-security.cjs`), but the patch is inert there: nothing requires deepmerge. No upstream release exists (latest is 4.3.1). Sole dependent @svgr/plugin-svgo 8.1.0 declares but never requires it (dist/index.js requires only svgo and cosmiconfig); no docs-ophis source references it. Build-time only, static site. |
| contracts | #1137 | `minimatch` unchanged | GHSA-g3hv-75wg-m249 | 0.04 / 0.01 | Patched 11.x is an incompatible major for consumers pinned ^3/^5 (eslint 8, glob 7/8, mocha 10). Installed 3.1.5/5.1.9 lack firstPhasePreProcess/secondPhasePreProcess, asserted in CI by contracts/test/security-dependencies.cjs. Dev/test toolchain over repo-controlled globs only. Both fingerprints already in audit/contracts-osv-baseline.json (review due 2026-11-15). |

Rows with a high Jev `reachable` (libp2p, elliptic, graphql-tools/utils) ship code that carries
the upstream fix as a local backport in `apps/railgun/patches`, with regression tests. See
`apps/railgun/DEPENDENCIES.md`. The version-based alerts cannot see pnpm patches.

## Frontend dependency bumps: compatibility record

Required by `apps/frontend/AGENTS.md` (dependency management).

| Bump | Release notes | Breaking changes for our consumers | Smoke tests run |
| --- | --- | --- | --- |
| glob 9.3.2/9.3.5/10.5.0/11.1.0 -> 14.0.3 (override `glob@>=9.0.0 <14.0.2`), with minimatch 11.0.4 and path-scurry 3.0.0 | [glob](https://github.com/isaacs/node-glob/blob/v14.0.3/changelog.md), [minimatch](https://github.com/isaacs/minimatch/blob/v11.0.4/changelog.md), [path-scurry](https://github.com/isaacs/path-scurry/blob/v3.0.0/README.md) | The `glob` CLI moved out (v13); absolute `ignore` patterns are anchored at `root`; minimatch 11 drops `makeRe` and the AST class; Node 20 or >=22 required. No consumer uses the CLI, `root` with absolute ignores, `signal`, `withFileTypes` or minimatch directly through glob. The named `glob`, `globSync` and `glob.sync` APIs used by @lingui/cli 5.5.1, @jest/reporters, jest-config and jest-runtime 30.2.0, react-cosmos 7.0.0 and @sentry/bundler-plugin-core 2.10/4.4 are unchanged. The frontend runs Node 22. | Each consumer's exact patterns and options run through the four old globs and 14.0.3 on the real repo: identical results in all 12 call shapes. Real `lingui extract` (1637 messages, locale files byte-identical). react-cosmos fixture discovery (57 cowswap / 303 explorer). Sentry 2.10 and 4.4 `writeBundle` upload hook. Jest coverage-threshold glob. `build:cowswap`, `explorer:build`, typecheck, CI dependency scripts. |
| next 15.5.27 -> 15.5.28 (`libs/ui`) | [v15.5.28](https://github.com/vercel/next.js/releases/tag/v15.5.28) | Security patch release, none. Next is not run as a server: the only import is the `next/image` client component in `libs/ui` CmsImage, bundled into the Vite SPA. | cowswap typecheck and `build:cowswap`. |
| astro 7.2.8 -> 7.3.5 (`@ophis/landing`, exact override) | [astro 7.3.5](https://github.com/withastro/astro/blob/astro@7.3.5/packages/astro/CHANGELOG.md) | Patch/minor releases, none for the landing. Held at 7.3.5 because 7.3.6+ needs vite ^8.3.1 and the existing `astro>vite` pin is 8.2.4. | Landing typecheck and full build, including the prebuild unit tests and the postbuild CSP-hash, CSP-guard (15/15) and FAQ-schema checks. |
| zod 3.25.76 -> 4.6.7 (`cowswap-frontend`) | [zod 4 changelog](https://zod.dev/v4/changelog) | `z.string().uuid()` is RFC-strict in zod 4, so `nearDirect.service.ts` uses `z.guid()` to keep the zod 3 behaviour. Zod 4 also rejects unsafe integers under `.int()`, datetimes without seconds and `Infinity`; the NEAR and CCTP APIs do not send those. | cowswap typecheck; Jest over `src/modules/cctp`, `src/modules/nearDirect` and `partnerFeeMerge` (36 suites, 201 tests). |
| minimatch 9.0.9/10.2.6 -> 11.0.4 for `@swc/cli` 0.7.8, `@typescript-eslint/typescript-estree` 8.46.0/8.54.0/8.56.1 and `@vue/language-core` 2.2.0 (parent-scoped overrides) | [minimatch](https://github.com/isaacs/minimatch/blob/v11.0.4/changelog.md) | `makeRe` and the AST class removed; Node 20 or >=22. These consumers only call the named `minimatch()`; nx keeps 10.2.5. | 157 old-vs-new call shapes identical; real paths (typescript-estree `allowDefaultProject`, `swc --only`, vue template codegen) identical; eslint on 4 files, `ui-utils:lint`, typecheck, `build:cowswap`. |
| `rollup-plugin-bundle-stats` removed (cowswap-frontend devDependency) | n/a | Only used in the opt-in `ANALYZE_BUNDLE` branch of `vite.config.mts`; `rollup-plugin-visualizer` still writes `build/cowswap/analyse.html`. Removes stream-json and its patch from every lockfile. | `build:cowswap`; `scripts/test-security-dependencies.cjs` now asserts no stream-json in the root and frontend graphs. |
| fast-uri 3.1.9, ip-address 10.7.4, qs 6.17.0, serialize-javascript 7.1.4 | [fast-uri](https://github.com/fastify/fast-uri/releases/tag/v3.1.9), [ip-address](https://github.com/beaugunderson/ip-address/releases/tag/v10.7.4), [qs](https://github.com/ljharb/qs/blob/v6.17.0/CHANGELOG.md), [serialize-javascript](https://github.com/yahoo/serialize-javascript/releases/tag/v7.1.4) | Patch/minor releases on the existing major, none. | osv gate and `build:cowswap`. |

## Other CI exceptions

- **braces GHSA-vfj7-8cjw-p6xm: removed.** GitHub withdrew the advisory on 2026-10-23, so the
  frontend and docs `--ignore` and the contracts baseline fingerprint are deleted (contracts high
  ceiling 2 -> 1). The pnpm braces backport and its regression stay.
- **crypto-bigint RUSTSEC-2026-0387: renewed to 2026-12-03.** Re-checked 2026-11-03: still no
  patched 0.5.x (latest 0.5.5; fixed only in >=0.7.6), and the latest alloy-signer (2.5.0) still
  requires k256/elliptic-curve ^0.13, so no upgrade path exists. The ignore is load-bearing: without
  it, or with an expired date, the Rust OSV gate fails closed on the ungraded finding.

## Supply-chain hardening (follow-up)

- **Railgun coverage.** `apps/railgun` (standalone pnpm project) now has its own `pnpm-audit-railgun`
  osv job in `security.yml`, blocking on HIGH/CRITICAL with three dated (2026-12-03) ignores for the
  backported zod, @graphql-tools/utils and @libp2p/peer-store residuals.
- **pnpm 10.34.9.** The root workspace, `apps/docs-ophis` and the rebate-indexer and mcp-server
  Dockerfiles moved from pnpm 9.12.0 (railgun from 10.33.2); 10.34.9 has no OSV advisories, while
  10.33.2 has 18 (11 HIGH, all fixed by 10.34.5), and it was published 2026-10-25, outside the 7-day
  window. The relock changes no package versions (only patch-hash format and `libc` metadata, plus
  re-linked peers: the optional zod peer of viem/ox/abitype in `packages/cli` now points at the
  already-locked `zod@4.6.7`, and `apps/safe-app`'s `@cowprotocol/app-data` cross-fetch peer (declared
  `^3.x`) moved from 3.2.0 to the already-locked `cross-fetch@4.1.0` that safe-swap and agent-swap
  already used; safe-app calls only `generateAppDataDoc`, so no IPFS fetch path is affected). The same
  11 root dependencies run build scripts as under pnpm 9, the reviewed no-op scripts are listed in
  `ignoredBuiltDependencies`, and `strictDepBuilds: true` (root and docs) fails the install on any
  build script in neither list. Both Docker images are built on every PR that touches their inputs,
  including `.dockerignore` and `tsconfig.base.json` (`rebate-indexer-ci.yml`, `mcp-deploy.yml`), and
  `docs-deploy.yml` now installs and builds docs on PRs without credentials.
- **Release-age policy.** New versions resolve only after 7 days (`minimumReleaseAge: 10080` in the
  root and docs `pnpm-workspace.yaml`, `minimum-release-age=10080` in `apps/railgun/.npmrc`). pnpm
  applies this only when it resolves dependencies; `--frozen-lockfile` installs (all CI and both
  Dockerfiles) do not re-check the age of entries already in the lockfile, so Dependabot security PRs
  and hand-edited lockfiles are not gated and need a manual publish-date check before merge. Each
  exclusion is an exact reviewed security release (root fastify 5.12.8 and qs 6.17.1; docs joi 17.13.9
  and qs 6.17.1; railgun minimatch 11.0.4 and @isaacs/nonrecursive-glob-match 1.0.3), so later
  releases of those packages still wait. Removing the fastify exclusion makes a re-resolve fall back to
  5.12.7, which confirms the policy is enforced on local resolution.
- **Railgun ignore scope.** The three railgun osv ignores match GHSA ids only, so the job also fails
  if osv reports any copy under them that is not an exact `pnpm.patchedDependencies` key.

## Renewal criteria

Re-review the zod and crypto-bigint exceptions together by 2026-12-03: remove zod's when the
listed SDKs ship zod 4, and crypto-bigint's when alloy moves to k256/elliptic-curve 0.14. Re-check
the railgun residuals after any Railgun SDK, Waku client or bundler change.
