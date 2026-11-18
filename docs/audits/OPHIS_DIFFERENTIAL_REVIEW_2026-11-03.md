# Review of security PRs #1623, #1624 and #1626

**Verdict: compatible client changes, with two broadcaster integration issues to resolve before a new broadcaster release.** The merged PRs pass their recorded GitHub workflows. The current RAILGUN client source also passes local regression, type and production-build checks using the merged dependencies. A fresh broadcaster install from the combined source fails, and its separate dependency tree has not received the corresponding security updates.

| Finding priority | Count | Meaning |
| --- | --- | --- |
| P1 | 1 | Confirmed broadcaster installation/rebuild blocker |
| P2 | 1 | Broadcaster dependency and audit coverage gap requiring resolution before production |
| Confirmed new exploitable application vulnerability | 0 | Dependency advisory matches are distinguished from proven runtime reachability |

## Exact scope and history

| PR | Reviewed head | Merge commit | Scope | GitHub evidence |
| --- | --- | --- | --- | --- |
| [#1623](https://github.com/ophis-fi/ophis/pull/1623) | `3b0151637d10a48ed6afea8ebac1fcebd898dc6a` | `c14f362464e2faad2b1b5a0f661518bf41e3dec3` | Dependency upgrades, local backports and regressions | 11 returned workflows succeeded; its review thread is resolved |
| [#1624](https://github.com/ophis-fi/ophis/pull/1624) | `a9de60b579603b05d6b0b8e7bacb8593883dafe7` | `6ebb212aa65fc8100a4ecc8a5cd351318c27b9eb` | Dependency audit coverage, pnpm and release-age policy, image/build checks | 11 returned workflows succeeded; its review thread is resolved |
| [#1626](https://github.com/ophis-fi/ophis/pull/1626) | `fb9e8e886a5430e43b2ccace3d2e812b0a247e50` | `d5c7486a91becebb6120f0f927af08638107564b` | CLI version and bundler exclusion | 5 returned workflows succeeded; no review threads returned |

Baseline: `cafd32b0486a85dd6669b1220be56dee3f0d05a3`. The cumulative PR diff contains **54 distinct changed files**. Review covered their changes, with deeper analysis of dependency patches, workflow trust boundaries and their RAILGUN/broadcaster consumers. Lockfiles were inspected as dependency graphs and package-integrity records, rather than as application source.

The current development checkout is `fix/private-mev-protection`, committed head `f6792c69`, with additional uncommitted pilot fixes. Git's committed merge simulation against merged main succeeds without conflicts and produces tree `ef4f0d952a393c868e07e08ec38950cb6d0ffa82`. A separate source snapshot combines that tree with the current broadcaster/client modifications for inspection and tests. The active checkout and deployed operator were not merged, rebuilt or restarted.

History/blame identifies `c55235d87` as the introduction of the client executor patch registration. #1623 removes that registration and its patch file after upgrading the client to executor 1.1.39. The broadcaster is a separate consumer introduced on the development branch, so main's PR checks never encounter its remaining reference.

## Findings

### P1 — Removed shared patch prevents a fresh broadcaster install

**Locations:** [current broadcaster package.json:44](/Users/scep/ophis-private-swap-design/apps/broadcaster/package.json:44), `apps/broadcaster/pnpm-lock.yaml:18`; removal in #1623 at `apps/railgun/patches/@graphql-tools__executor-legacy-ws@0.0.11.patch`.

The broadcaster's `patchedDependencies` and its frozen lockfile still reference the executor 0.0.11 patch under `../railgun/patches/`. #1623 deletes that file while moving the browser client to executor 1.1.39. The broadcaster's manifest is independent and keeps executor 0.0.11.

**Reproduction:** create the combined source, retain the frozen broadcaster manifest/lockfile, and install with scripts disabled in a separate non-root Node 22 container. The pnpm 10.34.9 executable was authenticated against the merged packageManager SHA-512 pin, with automatic version switching disabled. Installation exits **254** before dependency execution:

```text
ENOENT: no such file or directory, open
'/deps/apps/railgun/patches/@graphql-tools__executor-legacy-ws@0.0.11.patch'
```

The same missing input is required by the existing broadcaster Dockerfile's frozen dependency installation. This blocks rebuilding or restoring a fresh broadcaster release from the combined source. The running pilot image was not changed by this review.

**Required resolution:** bring the broadcaster's GraphQL dependency selection and lockfile forward, retaining compatible GraphQL Mesh peer resolution. Remove its obsolete patch registration, ensure every remaining patch is copied into the image, then verify frozen installation and the actual broadcaster image build. Restoring only the obsolete patch would leave the security-parity issue below unresolved.

### P2 — The separate broadcaster project is outside the new security hardening

**Locations:** [current broadcaster package.json:6](/Users/scep/ophis-private-swap-design/apps/broadcaster/package.json:6), [Dockerfile:7](/Users/scep/ophis-private-swap-design/apps/broadcaster/Dockerfile:7), `apps/broadcaster/.npmrc:1`, and [new audit job](https://github.com/ophis-fi/ophis/blob/d5c7486a91becebb6120f0f927af08638107564b/.github/workflows/security.yml#L499).

The new audit job scans `apps/railgun/pnpm-lock.yaml`. The broadcaster has its own ignored-workspace lockfile and is not covered by that scan, the root workspace dependency scan, or an explicit broadcaster installation/test job. General repository workflows may still run; their green results do not establish broadcaster dependency compliance.

Confirmed differences in the current broadcaster:

| Item | Merged client | Current broadcaster |
| --- | --- | --- |
| pnpm | 10.34.9 with integrity pin | 10.33.2; Dockerfile also pins 10.33.2 |
| Release-age policy | 10,080 minutes in standalone `.npmrc` | Absent |
| Legacy GraphQL executor | 1.1.39 | 0.0.11 with the now-missing TLS patch reference |
| `follow-redirects` | Fixed release line | 1.16.1 |
| zod 3.25.76 | Registered and regression-tested backport | No zod backport registration |
| Dedicated dependency audit | Present, with exact patched-version checks | Absent |

A fresh OSV scan of the broadcaster reports six HIGH package/advisory matches. Three correspond to patches already present in its current setup: the two GraphQL-utils copies and the legacy executor TLS backport. The remaining HIGH matches cover legacy executor connection-parameter state, follow-redirects and unpatched zod. There is also a MODERATE executor routing advisory. These are **version/patch-state findings**, not proof that those paths are exploitable through the current operator. In particular, the SDK's legacy WebSocket executor is not normally instantiated by the configured wallet path.

**Required resolution:** update the broadcaster's actual dependency graph and pnpm/Docker pins, add the applicable backports and their real-consumer tests, apply the standalone release-age configuration during resolution, and include its own frozen install, tests, image build and dependency gate in CI. Any retained advisory needs an explicit assessment of this Node service, rather than inheriting the browser bundle's reachability conclusion.

## Compatibility with the current development

Six relevant package versions and their upstream archive integrity hashes are identical across the current broadcaster and merged client: engine 9.9.1, wallet 11.2.0, shared-models 8.2.1, ethers 6.14.3, snarkjs 0.7.5 and elliptic 6.6.1. This is not an upgrade of the RAILGUN proof or signing protocol.

Thirteen critical source files were compared byte-for-byte between the active development source and the combined review snapshot. They preserve fee authentication and margin checks, signer/custody boundaries, the operator-bound execution guard, durable request accounting, private submission, saved-withdrawal handling and the explicitly requested PPOI-free policy. None of these PRs removes those development changes.

Baseline trust and state invariants examined:

- A submitted request must pay the authenticated first fee commitment and cover its maximum signed gas budget plus the configured margin before a signature is released.
- Signing is bound to the configured sender, full transaction body, gas caps, reserve and journal state. A dependency audit does not replace these checks.
- Private proofs and withdrawal state remain recoverable across unknown responses; no review step may clear the used withdrawal marker or submit an old saved proof.
- Client and broadcaster SDK instances must retain the explicit PPOI policy while preserving normal proofs and commitment authentication.

The direct frontend application change, `nearErrorMessage`, has three production call sites in two NEAR UI components. Its zod GUID change preserves broad UUID-shaped correlation IDs during the zod 4 migration; it does not change RAILGUN amounts or authorizations. The removed optional bundle-stat plugin changes build analysis output. #1626 changes the CLI version and keeps optional `pino-pretty` external; it does not change broadcaster transaction logic.

The critical cross-project impact is the shared executor patch deletion: one independent broadcaster manifest and lockfile continue consuming it. The audit coverage gap affects the entire independent backend dependency graph.

## Validation and coverage

| Check | Result |
| --- | --- |
| Merged PR metadata and review threads | All three merged; returned review threads resolved |
| GitHub workflow results | All returned PR-head workflows successful; connector workflow listing is first-page-only |
| Security workflow job details for #1624 | 23 returned jobs successful, including the new RAILGUN audit job and Slither |
| GitHub CodeQL | Analysis workflows succeeded on all three PR heads; success alone is not a claim of zero alerts |
| Fresh Semgrep | Six changed executable repository files, cached trusted rules, zero findings/errors/skipped rules |
| New client frozen install | Passed under Node 22 and pnpm 10.34.9, lifecycle scripts disabled |
| Current client with merged dependencies | **286 tests passed; 12 optional fork/live tests skipped** |
| Browser and server TypeScript | Passed |
| Client production build | Passed |
| Deployment-boundary regressions | 4 passed |
| Fresh client OSV gate | Passed with the three documented dated advisory-ID exceptions |
| Exact-version exception guard | All five affected installed package versions map to declared patches; negative control rejects a removed patch key |
| Fresh broadcaster installation | Failed on missing executor patch; confirmed blocker |
| Broadcaster raw OSV gate | Six HIGH version matches; patched and unpatched copies distinguished above |

Test detail: the broad client run passed 283 tests but could not load the three-test private-entry suite because the initial sanitized snapshot omitted two public frontend fixtures. After adding those exact public files from the merged tree, the isolated three-test suite passed. An earlier test-runner configuration syntax error was also corrected in the review harness. Neither failure required changing product code. Execution evidence retains these distinctions.

Dependency installation ran in a separate non-root container with install scripts disabled and no production credentials mounted. Node client tests, typechecks and the production build ran with networking disabled and read-only source/dependency mounts. The pnpm bootstrap matched the SHA-512 pin from merged main. Fresh OSV queries read lockfiles; they did not execute package code. Semgrep used the previously cached rule packs against a sanitized copy of the six changed executable files, with telemetry/version checks disabled and a clean environment. This static run and the four Python deployment-boundary tests ran on the host; neither is described as OS-network-isolated.

## Before the next broadcaster release

1. Resolve the obsolete executor reference through a compatible dependency/lockfile update.
2. Extend the security hardening to the independent broadcaster, including Docker inputs and CI coverage.
3. Re-run its frozen install, authenticated-fee/guard/recovery tests and image build against that exact graph before deployment. Keep the existing pilot limits and used withdrawal record intact.

No security-PR rollback is indicated by this review. A broadcaster release all-clear is withheld until the two integration issues are resolved.

## Limits and evidence

This is a focused differential and integration review, not a new complete audit of all upstream packages. Wider frontend, root, docs and CLI suites were checked through their PR-head CI evidence rather than all repeated locally. No new live swap, withdrawal, wallet pairing, npm publication, production deployment or guard deployment was performed. The retained optional integration tests were not enabled. The unchanged guard was not independently re-scanned with Slither here; the recorded PR security job succeeded.

Private review evidence: `/Users/scep/ophis-railgun-evidence/pr-review-1623-1624-1626-20261103/`. It contains metadata/job snapshots, the combined source and patch-reference checks, pnpm integrity verification, frozen-install results, local validation logs, OSV results/gates, Semgrep results and the exact-version exception test. No operator or owner wallet secrets were accessed for this review.
