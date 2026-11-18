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

**Verdict.** No running service compiles a glob from untrusted input, so the advisory is not reachable. Gates: a dated `--ignore GHSA-fc5q-39xc-vjpf:2026-12-17` in the root, frontend, docs-ophis, railgun and broadcaster jobs; the two contracts copies are added to `audit/contracts-osv-baseline.json` (high 1 to 3), as that job gates on a reviewed baseline.

**Re-check by 2026-12-17**, or earlier if picomatch ships a fix (then upgrade and drop the ignores and the baseline lines), or if any service starts matching user-supplied globs.
