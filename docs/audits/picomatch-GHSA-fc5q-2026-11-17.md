# picomatch GHSA-fc5q-39xc-vjpf (CVE-2026-112366): review, 2026-11-17

**Status checked 2026-11-19.** GitHub [withdrew this advisory](https://github.com/advisories/GHSA-fc5q-39xc-vjpf) on 2026-11-18 at 15:38:56 UTC. The five previously open Dependabot alerts (1163, 1161, 1160, 1159 and 1157), and the separate contracts-tooling alert 1162, now return HTTP 410 as withdrawn. This is an upstream advisory change, not an additional Ophis release or proof that every parser input is safe. Keep the existing patches and regression checks pending review of the upstream resolution. The remaining three Dependabot alerts concern Zod and GraphQL Tools, as recorded in the [dependency status](dependency-review-2026-11-03.md#current-status-2026-11-19).

**Original advisory snapshot, 2026-11-17.** "picomatch vulnerable to ReDoS through single-branch repeated extglobs", HIGH, published 2026-10-19, in the OSV data the CI gates read from about 2026-11-17 16:00 UTC (the security workflow passed at 15:50 UTC and failed at 16:20 UTC on unchanged lockfiles). The advisory then identified releases through 4.0.7 as affected, with no patched release listed.

**What it takes.** A crafted glob pattern (repeated single-branch extglobs) compiles to a regular expression that backtracks catastrophically. Exploitation needs an attacker to choose the pattern, or the input matched against such a pattern.

**Where it is (osv-scanner, 2026-11-17).**

| Lockfile | Copies | How it is reached in production dependencies |
|---|---|---|
| pnpm-lock.yaml (root) | 2.3.2, 4.0.4 | `apps/mcp-server`: `agents` > `@rolldown/plugin-babel`, imported only by `agents/vite` (checked in the 0.13.3 tarball: `dist/vite.js`); the Worker imports `agents/mcp` only. `packages/cli`: WalletConnect `unstorage` > `anymatch`, fixed key patterns, local CLI |
| apps/frontend | 2.3.2 | build tooling (Lingui CLI, Babel plugin of styled-components, Astro) and WalletConnect `unstorage` in the browser (fixed patterns) |
| apps/docs-ophis | 2.3.2 | the Docusaurus build |
| apps/railgun | 2.3.2, 4.0.7 | `patch-package` (install time) |
| apps/broadcaster | 2.3.2, 4.0.7 | `react-native` code under `@graphql-mesh/cross-helpers`, never loaded in this Node service |
| contracts/yarn.lock | 2.3.2, 4.0.5 | Hardhat and test tooling, never deployed |

**Remediation, 2026-11-18.** The root, frontend, docs, Railgun, broadcaster and Business console now register exact-version pnpm patches for every resolved picomatch copy (2.3.2, 4.0.4 or 4.0.7). The parser's existing repeated-extglob protection missed single-branch wildcard patterns such as `+(*)z` and `+(*a)z`. The patch detects wildcard tokens inside a repeated extglob and uses the existing safe rewrite/literalization path. Escaped stars, character classes and ordinary negation patterns retain their behavior. Repeated wildcard extglobs that cannot be safely rewritten deliberately match their literal text.

`scripts/test-picomatch-security.cjs` tests every installed lockfile version, requires an active pnpm patch, and bounds the whole probe with a child-process timeout. It covers the reported patterns and ordinary matching behavior; removing the new condition reproduces the timeout. Each affected pnpm project's CI runs it, including Business console, which the initial Dependabot inventory did not list.

No reviewed running service accepts an untrusted glob. The two `contracts/yarn.lock` copies remain unpatched Hardhat/test tooling with repository-defined patterns, recorded in `audit/contracts-osv-baseline.json`; they were outside the five open Dependabot alerts at the November 18 review. Do not interpret the pnpm fix or advisory withdrawal as a fix for those Yarn copies.

**Scanner handling.** The existing dated `--ignore GHSA-fc5q-39xc-vjpf:2026-12-17` was retained during remediation because version scanners could not see the patch. This documentation follow-up does not change it or extend its expiry. Installed-package regression checks still enforce the backport; scanner databases can receive the withdrawal at different times. No alert was manually dismissed by this remediation.

**Re-check by 2026-12-17**, or earlier if picomatch ships a fix (then upgrade and drop the ignores and the baseline lines), or if any service starts matching user-supplied globs.
