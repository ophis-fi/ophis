# picomatch GHSA-fc5q-39xc-vjpf (CVE-2026-112366): review, 2026-11-17

**Advisory.** "picomatch vulnerable to ReDoS through single-branch repeated extglobs", HIGH, published 2026-10-19, in the OSV data the CI gates read from about 2026-11-17 16:00 UTC (the security workflow passed at 15:50 UTC and failed at 16:20 UTC on unchanged lockfiles). Affected: every picomatch release up to 4.0.7. **No patched release exists.**

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

No reviewed running service accepts an untrusted glob. The two `contracts/yarn.lock` copies remain unpatched Hardhat/test tooling with repository-defined patterns, recorded in `audit/contracts-osv-baseline.json`; they are outside the five open Dependabot alerts. Do not interpret the pnpm fix as a fix for those Yarn copies.

**Scanner handling.** The existing dated `--ignore GHSA-fc5q-39xc-vjpf:2026-12-17` remains because OSV and Dependabot match the upstream version and cannot see the patch. Installed-package regression checks enforce the backport. No alert was dismissed and no expiry was extended. [Upstream advisory](https://github.com/advisories/GHSA-fc5q-39xc-vjpf).

**Re-check by 2026-12-17**, or earlier if picomatch ships a fix (then upgrade and drop the ignores and the baseline lines), or if any service starts matching user-supplied globs.
