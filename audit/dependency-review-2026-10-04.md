# Dependency and review-gate assessment — 2026-10-04

## Decision and scope

Reviewed the dependency changes from PR #1527 (`75709c642057927ce93da3645081e542653dd8bb`),
its three failing dependency gates, and the OTC review-evidence lifecycle. Main at review time
was `5683afba6db260a70da6d66c8e4f477e62dae256`.

Recommendation: accept the scoped dependency changes and braces exception below, subject to
the normal authenticated Codex review and required CI checks. Change risk is MEDIUM because
review-evidence validation changes. No unauthenticated gate bypass was demonstrated. Two
reproduced lifecycle consistency defects were fixed. This is a focused differential review,
not a new full application or smart-contract audit.

## Changes

| Area | Result |
| --- | --- |
| Frontend dependency manifests/lock | Retain probe-image-size 7.4.0; constrain future upgrades to major 7 |
| Frontend, docs, contracts manifests/locks | Upgrade every http-cache-semantics resolution to 4.3.0 |
| Security workflow and contracts baseline | Review only GHSA-vfj7-8cjw-p6xm, with the boundaries below |
| Codex dispatcher/evaluator | Check the same clean-result grammar and invalidate edited evidence |
| Dependency tests and workflows | Exercise installed cache behavior in all three workspaces |
| Existing Verity proofs | Restore compatibility with the pinned framework; all 38 Guardian theorems check |

Lockfile comparison found no unrelated package additions, removals or upgrades. The frontend's
release-age delay was disabled for the one lockfile regeneration after reviewing the published
4.3.0 source. The committed one-week policy and its exclusion list are unchanged; a subsequent
frozen install succeeded with that policy enabled.

## http-cache-semantics

4.3.0 was published on 2026-10-04. Comparing published 4.2.0 and 4.3.0 found an additive
`status()` API, a response status in `evaluateRequest`, and corrected `Vary` wildcard/header
matching. The upstream suite passed 128 tests. The installed-package regression checks
normal caching, serialization, private/no-store rejection, mandatory revalidation, mixed and
whitespace `Vary: *`, and inherited request-header rejection.

Do **not** describe this as a source fix for the `max-stale` claim in GHSA-ch52-4w7c-c8xp:
that logic remains unchanged. The maintainer disputes the report because freshness and
permission to share a response are different rules. The advisory currently covers versions
through 4.2.0, so 4.3.0 clears the current scan without an ignore. Callers must still honor
`storable()`; freshness checks alone do not authorize storing private responses.

Sources: [published 4.3.0 source](https://github.com/kornelski/http-cache-semantics/tree/b1d4bd682fbab0252985de45219f4e7497c0067c),
[maintainer explanation](https://github.com/kornelski/http-cache-semantics/issues/56#issuecomment-5975759591),
[advisory withdrawal request](https://github.com/github/advisory-database/issues/10139).

## braces: reviewed exception, not a package fix

GHSA-vfj7-8cjw-p6xm is real: deeply nested **patterns** can exhaust recursive AST walkers in
braces 3.0.3. No patched release exists. Upstream PR #72 is still unmerged; maintaining its
parser/AST patch across pnpm and the legacy Yarn toolchain is unnecessary for the caller
boundaries found here.

| Workspace | All direct parents | Reviewed inputs |
| --- | --- | --- |
| Frontend | chokidar 3.5.1/3.6.0; micromatch 4.0.8 | Configured watch, source-discovery, lint and build globs |
| Docs | chokidar 3.6.0; micromatch 4.0.8 | Docusaurus source paths, webpack/watch configuration |
| Contracts | chokidar 3.5.3/3.6.0; micromatch 4.0.8 | Hardhat source/deploy paths, Mocha CLI globs, lint configuration |

Reverse lockfile traversal covered 109 frontend, 31 docs and 20 contracts ancestor snapshots.
Published chokidar calls `braces.expand(path)` on its configured watch path. fast-glob calls
`micromatch.braces(pattern, {expand: true})` on its configured pattern. The dev proxy's
http-proxy-middleware passes the HTTP pathname as the **candidate**, not the glob pattern.
Hardhat deployment watches use `hre.config.paths.sources` and deployment paths, only when
watch mode is enabled. Mocha watch patterns come from local CLI configuration.

Repository evidence:

- `apps/frontend/lingui.config.ts`: source paths and excludes are configured by the repository.
- `apps/frontend/apps/ophis-landing/src/content.config.ts`: literal content globs.
- `apps/frontend/apps/ophis-landing/astro.config.mjs`: static output.
- `.github/workflows/cloudflare-deploy.yml`: published web assets, not the Node build toolchain.
- `.github/workflows/docs-deploy.yml`: stages static files without node_modules or Functions.
- `contracts/hardhat.config.ts`: configured local source paths; deployed Solidity does not
  execute the JavaScript deployment/test toolchain.
- Source searches across frontend, docs, contracts, Functions and scripts found no direct
  application imports of braces, micromatch, globby, fast-glob, chokidar, got or http-cache-semantics.

This does not claim that development dependencies are automatically safe. The decision rests
on the pattern's origin and the deployment boundary. Repository contributors can already run
arbitrary build code in CI; this finding adds no identified deployed user-input path.

Frontend/docs use the existing dated-exception mechanism, valid through **2026-10-18**; on the following
day the gate rejects it. Contracts adds only `braces@3.0.3 GHSA-vfj7-8cjw-p6xm high` and raises
the HIGH ceiling from 1 to 2. Its baseline has **no automatic expiry**. Re-review that exact
entry on the same date. Other package versions, advisories and severity changes still fail.

Remove these entries and restore the contracts HIGH ceiling when a compatible patched release
ships. Reassess immediately if a runtime import, user-configurable glob API, or hosted build/watch
service is introduced. Static review did not identify any such entry point.

Sources: [advisory](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm),
[upstream report](https://github.com/micromatch/braces/issues/70),
[unmerged patch](https://github.com/micromatch/braces/pull/72).

## Review-evidence defects and fixes

The gate originated in commit `46dcf596`; `c8612f2c` intentionally excluded mutable status
summaries. Those summaries remain non-authoritative and do not invalidate a clean result.

1. The dispatcher exempted edited clean-looking comments from lifecycle checkpoints, while
   the evaluator checked creation time alone. A later `updated_at` still passed. Now edits
   always checkpoint, and clean evidence requires matching valid creation/update timestamps.
2. The dispatcher accepted a reviewed-SHA substring anywhere after the clean prefix; the
   evaluator required the reviewed-commit line immediately afterward. An intervening line
   could therefore suppress invalidation without being valid new evidence. Both now enforce
   the same grammar and normalize CRLF identically.

These events require the authenticated Codex bot; this is a lifecycle correctness fix, not a
claim of an unprivileged account impersonating Codex. Tests execute the actual Bash/jq condition
and compare it with the evaluator for created/edited/deleted, malformed and wrong-head cases.
An independent reviewer also checked 80 formatting/lifecycle combinations without disagreement.
Head/base binding, trusted request association and newest-checkpoint freshness remain required.

## Verity proof compatibility

The existing Guardian proofs used an obsolete `ContractState.storageAddr` record field. Updated
the unfold lemma to the current `writeAddrSlot` representation and adjusted the affected proof
steps. All 38 theorem names remain; the model, specifications, invariants and Solidity are
unchanged. The reproduction instructions now pin Verity commit
`98533b72d2c93546e135d6b9e3aac08c5dbc06a8` and Lean 4.31.0.

The model, specification, invariants and proofs compile. Printing every theorem's axioms found
only standard Lean axioms (`propext`, `Classical.choice`, `Quot.sound`), without `sorryAx` or
custom axioms. The existing Rewards model and Properties module also compile. These checks
cover the Verity models, not Solidity bytecode equivalence or the JavaScript security gates.

## Validation and review methods

- Fresh OSV 2.4.0 scans: frontend/docs pass with the one dated braces exception; contracts
  passes against its exact reviewed fingerprints. No http-cache-semantics ignore was added.
- Frozen installations, frontend and docs typechecking, both production builds, existing
  frontend dependency regressions and contracts signing/tooling regressions passed.
- New installed cache regression passes in all three workspaces.
- OSV gate: 16 regression checks passed, including exception expiry and unrelated-advisory rejection.
- OTC evaluator/dispatcher self-test passed; changed workflow YAML parses; `git diff --check` passed.
- Verity: Guardian's 38 theorems compile and pass the axiom audit; Rewards model/properties compile.
- Ponytail guided reuse of existing override, exception and self-test mechanisms. Trail of Bits
  differential review covered caller reachability, history and validation. Pashov judging separated
  reproduced lifecycle defects from unproven attacker-trigger claims. ETHSkills informed the
  distinction between deployed contract behavior and the offchain build/deployment toolchain.
- TypeSafe Jev 1.13.0 independently checked three bounded evidence claims: retained gate
  authentication (confidence 0.86), edit invalidation (0.95), and honest exception scope (0.95).
  These judgments did not authorize a merge or replace executable checks.

## Remaining boundaries

The PR still needs a trusted exact review request and a subsequent authenticated clean Codex
result for its final head/base. This patch does not fabricate review evidence or bypass that gate.
The temporary braces acceptance remains a reviewed limitation, not a vulnerability fix.
