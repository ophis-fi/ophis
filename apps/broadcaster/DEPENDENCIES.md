# Broadcaster dependency integration, 4 November 2026

This standalone Node service has its own lockfile. Browser bundle reachability and a green root-workspace audit do not establish its dependency safety. It now follows current Ophis's reviewed pnpm 10.34.9 pin, seven-day resolution age and scripts-disabled installation policy. Docker reads the integrity-pinned `packageManager` from the same manifest and includes `.npmrc` and every registered patch.

The engine 9.9.1, wallet 11.2.0, shared-models 8.2.1, ethers 6.14.3, snarkjs 0.7.5, noble/ed25519 1.7.5 and elliptic 6.6.1 upstream archive versions/integrities are unchanged. The application bundle also reproduces the tested pilot bundle. External dependency changes are validated separately; matching application bytes alone is not a compatibility guarantee.

| Package | Disposition and verification |
| --- | --- |
| `@graphql-tools/executor-legacy-ws` | Exactly 1.1.39 replaces 0.0.11 and its deleted shared TLS patch. Tests exercise the Node SDK's actual `UrlLoader.buildWSLegacyExecutor` consumer in CJS and ESM for TLS verification, separate connection parameters and subscription-ID routing. |
| `@graphql-tools/utils` | Direct 9.2.1 preserves the Mesh peer selection. Versions 8.13.1 and 9.2.1 retain the reviewed prototype-key backports, tested through real SDK consumers in CJS/ESM. The executor's own 12.1.0 is an upstream fixed release. |
| `follow-redirects` | Exactly 1.16.2 replaces 1.16.1, matching the reviewed Ophis fix. |
| `zod` 3.25.76 | Uses Ophis's existing oversized-collection backport. Tests resolve the SDK's own `http → fets → zod-to-json-schema → zod` path, then run the shared CJS and ESM security/ordinary-behavior regressions. No incompatible zod 4 override is added to v3 consumers. |
| `vitest` | 4.1.12 replaces 4.1.11 and its affected mocker; this changes test tooling, not the production signing/proof SDK. |
| `elliptic` 6.6.1 | Retains the existing nonce-byte-length backport; the version-only LOW advisory remains. |
| `minimatch` 5.1.9 | Retains the previously reviewed MODERATE advisory disposition in `audit/dependency-review-2026-11-03.md`: this release lacks the advisory's amplification implementation. It is not excluded by the HIGH/CRITICAL gate. |

Fresh OSV results retain three HIGH version matches: GraphQL-utils 8.13.1 and 9.2.1 (GHSA-7mx3-vvmw-hjmv) and zod 3.25.76 (GHSA-mrhx-c7xc-m3w5). All three are patched and exercised through their actual consumers. The gate exceptions expire on **3 December 2026**; the workflow additionally rejects an ignored advisory on any package/version not registered in that project's `patchedDependencies`. Review or remove the exceptions before expiry and after any SDK, GraphQL or bundler change.

The fresh gate passes with those exceptions. This is not a zero-advisory tree or proof that every upstream code path is safe. The client-only libp2p exception is not applied to the broadcaster.

The seven-day age policy also selected older eligible Babel/rolldown/browser-metadata transitive releases during lockfile regeneration. Those changes are recorded in the integration evidence and covered by fresh audit, typecheck, test and build checks. No broad cross-major uuid/minimatch overrides were copied from the browser project.

Evidence is retained in the private `integration-20261104` record. Further fee collection, repeat-user admission, hosted UX, operational monitoring and final release acceptance remain separate work in the development plan.
