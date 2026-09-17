# Ophis security audit — 2026-09-17

Base: `2541dfae` on `main`. Changes are on `fix/security-audit-20260917`; no mainnet deployment, signing operation, merge, or alert dismissal was performed.

## Results

GitHub initially reported 32 open Dependabot alerts. This change removes affected versions/declarations for 29, backports the fix for 2 `stream-json` alerts, and leaves 1 legacy contracts decoder alert unresolved. GitHub will reevaluate version alerts after the branch is merged; patched copies can remain flagged by version-only scanners.

A broader OSV scan found 196 advisory/package/version findings across four JavaScript lockfiles. After remediation, 30 remain, including both locally patched stream-json copies. These counts include development dependencies and previously accepted legacy findings, so they differ from Dependabot alert counts.

| Workspace | Before | After | After critical / high / moderate / low |
| --- | ---: | ---: | --- |
| `pnpm-lock.yaml` | 12 | 3 | 0 / 1 / 1 / 1 |
| `apps/frontend/pnpm-lock.yaml` | 23 | 6 | 0 / 0 / 3 / 3 |
| `apps/docs-ophis/pnpm-lock.yaml` | 10 | 0 | 0 / 0 / 0 / 0 |
| `contracts/yarn.lock` | 151 | 21 | 2 / 1 / 11 / 7 |

## Original Dependabot alerts

| Alerts | Package / manifest | Treatment |
| --- | --- | --- |
| [#982](https://github.com/ophis-fi/ophis/security/dependabot/982) | `@ai-sdk/provider-utils` in `pnpm-lock.yaml` | Upgrade to 4.0.33 or newer 4.x |
| [#972](https://github.com/ophis-fi/ophis/security/dependabot/972) | `@humanfs/node` in `apps/frontend/pnpm-lock.yaml` | Upgrade to 0.16.8 |
| [#983](https://github.com/ophis-fi/ophis/security/dependabot/983) | `@swc/html` in `apps/docs-ophis/pnpm-lock.yaml` | Upgrade to 1.16.2 |
| [#993](https://github.com/ophis-fi/ophis/security/dependabot/993) | `@vitest/mocker` in `apps/frontend/pnpm-lock.yaml` | Upgrade to 4.1.11 |
| [#1003](https://github.com/ophis-fi/ophis/security/dependabot/1003) | `@vitest/mocker` in `pnpm-lock.yaml` | Upgrade to 4.1.11 |
| [#997](https://github.com/ophis-fi/ophis/security/dependabot/997) | `adm-zip` in `apps/frontend/pnpm-lock.yaml` | Upgrade to 0.6.1 |
| [#1000](https://github.com/ophis-fi/ophis/security/dependabot/1000) | `adm-zip` in `contracts/yarn.lock` | Upgrade to 0.6.1 |
| [#967](https://github.com/ophis-fi/ophis/security/dependabot/967) | `browserslist` in `contracts/yarn.lock` | Upgrade to 4.28.7 or newer 4.x |
| [#985](https://github.com/ophis-fi/ophis/security/dependabot/985) | `colord` in `apps/docs-ophis/pnpm-lock.yaml` | Upgrade to 2.9.4 |
| [#961](https://github.com/ophis-fi/ophis/security/dependabot/961) | `decode-uri-component` in `apps/frontend/pnpm-lock.yaml` | Upgrade to 0.5.0 with module-format-only CommonJS compatibility patch. |
| [#962](https://github.com/ophis-fi/ophis/security/dependabot/962) | `decode-uri-component` in `contracts/yarn.lock` | UNRESOLVED: legacy CommonJS contracts toolchain; migration needed. |
| [#963](https://github.com/ophis-fi/ophis/security/dependabot/963) | `decode-uri-component` in `pnpm-lock.yaml` | Upgrade to 0.5.0 with module-format-only CommonJS compatibility patch. |
| [#1005](https://github.com/ophis-fi/ophis/security/dependabot/1005), [#1006](https://github.com/ophis-fi/ophis/security/dependabot/1006), [#1007](https://github.com/ophis-fi/ophis/security/dependabot/1007) | `hono` in `pnpm-lock.yaml` | Upgrade to 4.13.5 |
| [#984](https://github.com/ophis-fi/ophis/security/dependabot/984), [#986](https://github.com/ophis-fi/ophis/security/dependabot/986) | `joi` in `apps/docs-ophis/pnpm-lock.yaml` | Upgrade to 17.13.6 |
| [#990](https://github.com/ophis-fi/ophis/security/dependabot/990), [#991](https://github.com/ophis-fi/ophis/security/dependabot/991) | `next` in `apps/frontend/libs/ui/package.json` | Upgrade to 15.5.24 |
| [#965](https://github.com/ophis-fi/ophis/security/dependabot/965), [#966](https://github.com/ophis-fi/ophis/security/dependabot/966) | `postcss-selector-parser` in `apps/docs-ophis/pnpm-lock.yaml` | Upgrade to 6.1.3 / 7.1.3 or newer in the same major |
| [#964](https://github.com/ophis-fi/ophis/security/dependabot/964) | `postcss-selector-parser` in `apps/frontend/pnpm-lock.yaml` | Upgrade to 6.1.3 / 7.1.3 or newer in the same major |
| [#970](https://github.com/ophis-fi/ophis/security/dependabot/970), [#971](https://github.com/ophis-fi/ophis/security/dependabot/971) | `qs` in `apps/docs-ophis/pnpm-lock.yaml` | Upgrade to 6.16.0 |
| [#976](https://github.com/ophis-fi/ophis/security/dependabot/976), [#977](https://github.com/ophis-fi/ophis/security/dependabot/977) | `qs` in `pnpm-lock.yaml` | Upgrade to 6.16.0 |
| [#980](https://github.com/ophis-fi/ophis/security/dependabot/980) | `stream-json` in `apps/frontend/pnpm-lock.yaml` | Local 1.9.1 filter-depth backport; version alert remains. See compatibility notes. |
| [#981](https://github.com/ophis-fi/ophis/security/dependabot/981) | `stream-json` in `pnpm-lock.yaml` | Local 1.9.1 filter-depth backport; version alert remains. See compatibility notes. |
| [#992](https://github.com/ophis-fi/ophis/security/dependabot/992) | `vitest` in `apps/frontend/package.json` | Upgrade to 4.1.11 |
| [#994](https://github.com/ophis-fi/ophis/security/dependabot/994) | `vitest` in `apps/frontend/pnpm-lock.yaml` | Upgrade to 4.1.11 |
| [#1002](https://github.com/ophis-fi/ophis/security/dependabot/1002) | `vitest` in `integrations/heyanon/ophis/package.json` | Upgrade to 4.1.11 |
| [#1004](https://github.com/ophis-fi/ophis/security/dependabot/1004) | `vitest` in `pnpm-lock.yaml` | Upgrade to 4.1.11 |

## Source findings fixed

- **Request-body resource exhaustion (medium):** MCP and compat APIs previously enforced limits only after buffering; MCP also counted UTF-16 characters instead of bytes. Both now enforce byte limits while reading and cancel oversized streams. Pages middleware applies a 64 KiB limit before POST handlers parse JSON. Regression cases cover chunked bodies, cancellation, split UTF-8, and forwarding. Files: `apps/mcp-server/src/index.ts`, `apps/compat-api/src/index.ts`, `functions/_middleware.ts`.
- **Workflow shell/environment injection (restricted dispatch surface):** toxic-pool workflow interpolated dispatch values into Bash source. Values now enter through environment variables; the scan window is allowlisted before writing `GITHUB_ENV`. Tests execute the workflow script with malicious shell/newline inputs.
- **Risk-feed validation (medium correctness/integrity):** timezone-naive timestamps could change freshness decisions by host timezone; malformed collections could collapse into an apparently empty scan. The normalizer rejects ambiguous timestamps, booleans, non-array collections, and invalid flags using existing validation.
- **Audit gate bypass by count substitution:** the contracts gate previously allowed an unrelated new advisory when a different finding disappeared. It now checks exact package/version/advisory/severity fingerprints and severity ceilings. Scanner errors, malformed result shapes and unclassified advisories fail closed. A separate low-severity finding can no longer supply the severity of an unclassified advisory. Fourteen regression checks run in Security CI.
- Root CI now fails on lint/typecheck errors instead of swallowing them. The only lint target used an unconfigured ESLint 9 invocation; it now runs the existing TypeScript compiler with unused-local/parameter checks, which pass without extra dependencies.
- Removed the five GitHub CodeQL cleanup findings: three unused rebate-indexer symbols and two empty Python exception paths.
- Corrected the frontend test that treated the registered Uniswap v4 lane on Unichain as an unknown solver. Production attribution behavior is unchanged.

## Dependency compatibility and cleanup

- `patches/decode-uri-component@0.5.0.patch` changes only the upstream fixed decoder’s module type and export assignment. Both query-string 5 and 7 still handle normal/malformed UTF-8, plus signs, and percent decoding once. A 300 KB malformed run completes promptly.
- `patches/stream-json@1.9.1.patch` bounds the path-search stack at 1024 levels, matching the upstream 3.5 mitigation while retaining the v1 CommonJS API used by Jayson and bundle-stats. All four path filters reject adversarial 8192-level nesting; ordinary filtering and actual JSON-RPC streaming pass. It does not impose a global JSON size/depth policy on callers using plain streamers.
- Restored compatible `glob`, `minimatch`, and `brace-expansion` majors. Broad previous overrides made old consumers call nonexistent exports. The production build silently emitted an empty service-worker precache. A runnable Workbox manifest regression now requires a nonempty result; three obsolete ESLint API-adapter patches were deleted.
- Frontend `file-type` consumers all use the retained asynchronous buffer API; PNG/ZIP smoke checks pass. UUID 8/9 consumers use retained named exports; legacy UUID 3 subpath users remain separately identified.
- Contracts retained Hardhat 2 and Solidity 0.7-compatible OpenZeppelin. Same-major updates plus scoped resolutions remove obsolete crypto/parser dependencies without replacing deployed Solidity. Four missing Hardhat compiler overrides match existing Solidity 0.8.28/optimizer/Cancun settings. Test-only gas defaults use existing knobs and preserve explicit overrides.

## Residual risk and required follow-up

The remaining findings are not dismissed or called fixed. See the exact contracts fingerprints in `audit/contracts-osv-baseline.json`.

- **Contracts critical/high:** OpenZeppelin 3.4.0-solc-0.7 advisories concern TimelockController/Initializable and related components that have no production imports here; imported legacy OpenZeppelin fixtures are test-only. Babel 6 remains through Waffle 3 → Ganache 2 browser-build tooling, with no patched Babel 6 release. Eliminating these requires a reviewed legacy toolchain migration.
- **Contracts decoder:** `xhr-request` → query-string 5 → decode-uri-component 0.2.2 remains vulnerable by version. Fixed 0.5 is ESM, and a direct Yarn 1 override would break the callable CommonJS API. Unlike pnpm, this install does not apply the shared patch; no install-hook-dependent workaround or misleading dismissal was added.
- **Root bigint-buffer:** retained pre-existing documented exception through Coinbase AgentKit’s Solana development peer dependency; no patched release, and no Ophis Solana conversion path identified.
- **Legacy frontend/contracts packages:** request, old UUID, Web3 1, elliptic and contracts got/yargs-parser advisories remain. Old UUID consumers use v4 identifiers without attacker-provided buffers; UUID 11 removes legacy deep imports. Replacing these parent stacks requires compatibility work, not blanket major overrides.
- **Rust service lock:** event-listener updated to 5.4.2. `lru` 0.16.3 remains because Alloy 1.x constrains that major; patched lru requires an Alloy 2.x migration. The reported defect requires a panicking key destructor followed by caught unwind/reuse; observed keys are integers, fixed hashes, or strings without that destructor behavior. `rsa` is an optional inactive SQLx MySQL lock entry; this deployment uses PostgreSQL. Maintenance/yanked-crate warnings remain distinct from confirmed vulnerabilities.
- **Rust contracts-generator lock:** updated `h2` 0.4.13 → 0.4.16 and `rustls` 0.23.37 → 0.23.45, including required TLS transitive updates. Its raw cargo-audit findings fell from two to zero; maintenance/yanked-package warnings remain. This is the build-time artifact downloader, separate from the runtime service lock.
- **Contracts TypeScript benchmark:** full `yarn build:ts` still fails on pre-existing benchmark imports of removed Hardhat tracing APIs. SDK CommonJS/ESM builds, Solidity compilation and 51 Hardhat tests pass. A trace-backend rewrite is required; the benchmark feature was not deleted to hide the failure.

## Verification and coverage

- OSV 2.4.0: all four JavaScript lockfiles scanned before/after; all updated CI advisory gates pass with only the existing root bigint-buffer exception and the reduced explicit contracts baseline.
- Frozen dependency installations succeeded for root, frontend, docs, and a fresh contracts directory. Lifecycle scripts were disabled for installation validation.
- SDK: 236 tests; MCP: 94; compat: 82 with 2 existing skips; Pages Functions: 86; rebate indexer: 713 with 3 existing skips, including PostgreSQL containers; RPC: 2. Additional workspace checks passed: Safe swap 59, Safe App 15, widget 5, agent swap 18, GOAT 4, AgentKit 5; the Eliza plugin currently has no tests.
- Rust: targeted `event-listener`, `event-listener-strategy`, `async-lock`, and `moka` checks pass; the full standalone contracts-generator `cargo check --locked` passes. Main service workspace tests were not run.
- Contracts: 51 Hardhat tests plus dependency security smoke; 54-source Solidity compilation and SDK CommonJS/ESM builds.
- Python: 14 risk-feed/workflow tests and 9 Nitro proxy tests; infrastructure invariants pass. OSV found no known vulnerabilities across all 41 packages pinned in `requirements-scanner.lock`.
- Frontend: 260 suites, 2212 tests and 8 snapshots passed (7 existing skips); production build now emits 512 precache entries instead of zero.
- Typechecks: all 15 root workspace tasks, frontend and Pages passed. Documentation production build passed, including CSP injection.
- `node scripts/test-security-dependencies.cjs node_modules/.pnpm apps/frontend/node_modules/.pnpm`: decoder, stream filters, JSON-RPC, glob/minimatch, Workbox, file-type and UUID compatibility/security checks; separate-process 15-second timeout catches synchronous hangs, and unfinished asynchronous checks exit unsuccessfully. Root/frontend modes run in their existing CI jobs.
- `python3 scripts/test-osv-gate.py`: 14 fail-closed regression checks.
- Semgrep OSS: application scan 135 rules over 5195 files, 2 contextual false positives; Trail of Bits JS 9 rules over 3815 files, no matches. Infra official scan 266 rules over 968 targets, plus third-party Python/Rust/Solidity/container rules; confirmed workflow findings fixed. Parser diagnostics and container hardening suggestions are retained in local evidence. No Pro/cross-file Semgrep engine was available.
- Slither: six production entrypoints exactly match the existing 58-fingerprint baseline (0 added/removed). Expanded scan: 93 contracts, 101 detectors, 162 raw findings. Additional high/medium matches were contextual/test cases, except an existing floor-rounding precision observation bounded to one buy-token base unit. The caller rejects zero floors. This is not a full smart-contract correctness proof.
- Gitleaks: repository EVM-key rules had zero matches; default current-tree rules produced 564 generic matches, triaged as token addresses/fixtures rather than confirmed operational secrets. Git history and live credential validation were not scanned. GitHub secret-scanning reported no alerts.
- GitHub CodeQL findings were inspected; a fresh local CodeQL database was not built. GitHub CI can rescan the branch.

## Reproduction

```sh
python3 scripts/test-osv-gate.py
node scripts/test-security-dependencies.cjs node_modules/.pnpm apps/frontend/node_modules/.pnpm
osv-scanner --lockfile pnpm-lock.yaml --lockfile apps/frontend/pnpm-lock.yaml \
  --lockfile apps/docs-ophis/pnpm-lock.yaml --lockfile contracts/yarn.lock --format json
python3 -m unittest discover -s tools/toxic-pool-risk -v
```

The OSV command intentionally exits with findings; use `scripts/osv-gate.py` with the workflow’s reviewed policies to reproduce CI gating. Scanners detect known patterns/advisories; passing tests and reviewed baselines do not guarantee the repository is vulnerability-free.
