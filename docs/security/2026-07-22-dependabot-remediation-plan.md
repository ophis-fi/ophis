# Dependabot remediation plan — 2026-07-22

## Purpose and decision record

This plan turns the Dependabot-security-alert backlog into a tracked, testable remediation programme. It is based on the resolved dependency graph: a manifest edit or a closed alert is not proof of a fix. Since a pnpm override replaces the consumer's range, every change must regenerate the relevant lockfile and prove the resolved package version is patched.

The supplied Dependabot URL is access-controlled and could not be read from this execution environment (GitHub returned HTTP 401 and the direct API request was network-blocked). This document therefore records the alerts and residual risk established from the checked-out repository and recent remediation commits. Before implementation, an authenticated maintainer must export the complete open-alert list and attach it to the tracking issue. No alert may be silently assumed closed from this plan alone.

## What is already complete

Reconcile the following work against the authenticated alert export, then mark an alert **verified fixed** only when its dependency and manifest match.

| Area | Completed remediation | Alerts/advisories covered |
| --- | --- | --- |
| Root and frontend pnpm workspaces | Forced patched axios, tar, shell-quote, js-yaml and brace-expansion resolutions, then regenerated both lockfiles. | `GHSA-gcfj-64vw-6mp9`, `GHSA-23hp-3jrh-7fpw`, `GHSA-8x88-c5mf-7j5w`, `GHSA-395f-4hp3-45gv`, `GHSA-52cp-r559-cp3m`, `GHSA-3jxr-9vmj-r5cp`. |
| Frontend landing site | Raised Astro to 7.1.3, with scoped Astro cookie and Vite overrides so the resolution is real rather than masked by former global overrides. | `GHSA-4g3v-8h47-v7g6`, `GHSA-f48w-9m4c-m7f5`, `GHSA-7pw4-f3q4-r2p2`. |
| Docs workspace | Added its missing OSV gate and patched js-yaml, brace-expansion, shell-quote, SockJS's uuid, webpack-dev-server and body-parser. | `GHSA-52cp-r559-cp3m`, `GHSA-3jxr-9vmj-r5cp`, `GHSA-395f-4hp3-45gv`, `GHSA-w5hq-g745-h8pq`, plus two webpack-dev-server medium alerts. |
| Docs/frontend WebSocket dependency | Constrained `websocket-driver` to patched 0.7.x. | CVE-2026-54466 and CVE-2026-54490. |
| Contracts and integrations | Bumped axios and js-yaml where a compatible patched resolution existed; updated the generated Rust lock's serde_with and the HeyAnon Vitest constraint. | `GHSA-52cp-r559-cp3m`, `GHSA-7gcf-g7xr-8hxj`, `GHSA-5xrq-8626-4rwp`. |
| CI coverage | Added the docs-ophis OSV job; root, frontend and docs now block on non-ignored HIGH/CRITICAL resolved-lockfile findings. | Prevents recurrence in all three modern pnpm trees. |

## Known remaining risk to triage first

1. **Contracts legacy toolchain — highest programme priority.** The recorded baseline is 11 critical, 60 high, 52 moderate and 38 low resolved-lockfile findings. CI only rejects regressions because this Yarn v1/Hardhat stack is too old to make a safe one-off global override. In particular, `brace-expansion` remains through incompatible minimatch 3.x and 5.x consumers; the durable fix is a staged Hardhat/toolchain upgrade, not forcing one major everywhere.
2. **No-fix or non-reachable exceptions — verify, time-box, do not close as fixed.** The root `bigint-buffer` and frontend `ip` findings are ignored only after reachability assessment and a check that no patched release exists. The HeyAnon `tsup` advisory was documented as having no patched release and as inapplicable to its Node ESM build. Each exception needs an owner, evidence link, next-review date and compensating control; if Dependabot permits it, dismiss it with that exact rationale.
3. **Any alert not in the preceding categories is unclassified.** Treat it as blocking until its exact package, version, dependency path, severity, first-patched version and affected manifest are recorded. Do not infer that an advisory is fixed merely because another workspace has a similar override: root, frontend, docs and contracts resolve independently.

## Execution plan

### Phase 0 — establish the authoritative alert ledger (security)

1. An authenticated maintainer exports every **open** Dependabot alert: alert number, GHSA/CVE, severity, package, vulnerable and first-patched ranges, manifest path, dependency scope/path, timestamps and dismiss state.
2. Create `docs/security/dependabot-alert-ledger.csv` from the export. Keep one row per alert, not one per GHSA, because the same advisory in separate manifests has independent remediation.
3. Reconcile each row with the completion table. Query the current lockfile to prove the package no longer resolves vulnerably, then close it as fixed or retain it as open with its actual dependency path.
4. Run OSV against `pnpm-lock.yaml`, `apps/frontend/pnpm-lock.yaml`, `apps/docs-ophis/pnpm-lock.yaml` and `contracts/yarn.lock`; save JSON artifacts with the review. Run `cargo audit` for maintained Rust lockfiles. Record, never discard, differences between OSV and Dependabot.

**Exit criterion:** every open Dependabot alert has a ledger row and none is labelled “unknown path” or “assumed fixed”.

### Phase 1 — eliminate modern, patchable dependency alerts (workspace maintainers)

1. Group ledger rows by the four independent JS resolution roots: root pnpm, `apps/frontend`, `apps/docs-ophis` and `contracts`; keep Docker and GitHub Actions as separate groups. A root pnpm override cannot claim a frontend/docs/contracts fix.
2. For a compatible patched release, upgrade the direct introducer first. Use a narrowly scoped override/resolution only when necessary, constrain it to a compatible major, regenerate the matching lockfile and inspect the resolved entry.
3. For breaking upgrades, use a small, one-package PR: read release notes, update tests/configuration, build the affected application and run targeted tests. Astro/Vite/CSP needs the landing build plus hash check; docs needs its build; package changes need package test/typecheck.
4. Close the Dependabot alert only after merge and a fresh alert view confirms that the affected manifest no longer resolves the vulnerable version.

**Exit criterion:** no open HIGH/CRITICAL alert in root, frontend or docs, except a formally approved no-fix exception with documented reachability review.

### Phase 2 — retire the contracts baseline (contracts and security)

1. Generate a package-and-path breakdown for all 161 baseline findings. Rank by severity, production/deploy reachability, patched-version availability and number of dependent paths. Split duplicate GHSAs into one upgrade decision per introducing tool.
2. Land compatible bumps with `yarn install --frozen-lockfile`, contract compilation and relevant Hardhat/Foundry tests. Ratchet the baseline downward after each verified fix; never increase it merely to make CI green.
3. Stage breaking upgrades around the old Hardhat/Waffle/deployment stack. Upgrade minimatch's introducer rather than forcing incompatible `brace-expansion` majors. Replace or upgrade packages with no patched release only after proving whether they enter deployment artifacts or test-only tooling.
4. When HIGH/CRITICAL findings are eliminated or have accepted time-boxed exceptions, change the contracts job from baseline-regression mode to the same absolute HIGH/CRITICAL gate used by pnpm workspaces.

**Exit criterion:** contracts has a zero HIGH/CRITICAL baseline, then no baseline; CI blocks newly introduced HIGH/CRITICAL contracts advisories.

### Phase 3 — govern exceptions and prevent recurrence (security and DevOps)

1. Every no-patch, false-positive or unreachable alert records its dependency path, reachability proof, affected deployment surface, compensating control, owner and review date no more than 30 days away. Re-test after upstream releases or lockfile changes.
2. Keep Dependabot coverage aligned with actual manifest roots. Add a Dependabot entry for each new standalone dependency root; retain separate OSV/cargo gates for vendored or excluded trees. Verify Docker alerts against monitored Dockerfiles and digest-pin patched base images.
3. Preserve the Monday scheduled security workflow and retain artifacts for the ledger owner. A newly discovered advisory must alert even when no source PR is open.
4. Quarterly, compare the Dependabot export, OSV outputs, cargo-audit output, CI ignore lists and the contracts baseline. Close stale dismissals and reject exceptions without current evidence.

**Exit criterion:** every exception has an unexpired owner/review date; maintained dependency roots have an absolute HIGH/CRITICAL gate; ledger and CI scans agree or explain their difference.

## Required verification per remediation PR

Run the narrowest applicable command first, then the affected security gate:

```bash
osv-scanner --lockfile pnpm-lock.yaml --format json
osv-scanner --lockfile apps/frontend/pnpm-lock.yaml --format json
osv-scanner --lockfile apps/docs-ophis/pnpm-lock.yaml --format json
(cd contracts && yarn install --frozen-lockfile --ignore-scripts)
osv-scanner --lockfile contracts/yarn.lock --format json
(cd apps/backend && cargo audit)
```

Also run the affected workspace build, typecheck and targeted tests. A dependency-upgrade PR must link upstream release notes, state whether the alert is direct or transitive, show before/after resolved versions, and identify the Dependabot alert number(s) it closes.
