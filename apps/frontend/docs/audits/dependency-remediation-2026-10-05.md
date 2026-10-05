# Verification and remediation of the nine dependency advisories

## Result and scope

All nine findings from the local AssetSwap review have a verified remediation in
the **frontend workspace's installed dependency graph**. Five already had patches;
this review upgraded two packages to address three findings and backported one
build-tool fix. No currently exposed exploit path from swap inputs was identified.
This is a dependency assessment, not a complete application or contract audit.

The earlier report incorrectly described all nine as still open without checking
the existing patches. The raw scanner count was accurate; its interpretation was
incomplete. The patches have now been inspected and exercised against installed code.

| Raw scan severity | Before | After |
| --- | ---: | ---: |
| Critical | 0 | 0 |
| High | 1 | 1 |
| Moderate | 4 | 2 |
| Low | 4 | 3 |

The six remaining version-based alerts correspond to **six active local patches**.
No new ignore or severity downgrade was added. Raw `pnpm audit --prod` still exits 1;
it does not assess the applied source patches. Do not call this a zero-advisory scan.

Change risk: **medium**, because glob parsing is shared by build and test tools.
Recommendation: **accept for local testing**. No merge, push or deployment was
performed. Other workspaces and deployed environments were not changed.

## Finding-by-finding impact

| Advisory / package | Impact in the reviewed application | Verified disposition |
| --- | --- | --- |
| [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm), `braces@3.0.3`, high | Deep patterns can exhaust recursive traversal. Direct parents are chokidar 3.5.1/3.6.0 and micromatch 4.0.8. Their patterns come from repository build/watch configuration; no swap-input pattern API was found. No braces source appears in the production swap build. | **Fixed locally now:** cap nesting at 100 during parsing and AST processing; reject cyclic parent chains. Ordinary glob and quoted-literal behavior is preserved. No published fixed release currently exists. |
| [GHSA-p8p7-x288-28g6](https://github.com/advisories/GHSA-p8p7-x288-28g6), `request@2.88.2`, moderate | Legacy Explorer Web3 → Swarm → servify dependency. No request source appears in the swap build. Cross-protocol redirects could otherwise discard a filtering HTTP agent. | **Already patched:** retain the agent across protocol changes by default. Installed tests confirm normal redirects work and the protocol-change bypass rejects. No repository caller enables `allowInsecureRedirect`. |
| [GHSA-2j4c-9qqq-896r](https://github.com/advisories/GHSA-2j4c-9qqq-896r), `web3-core-method@1.10.3`, low | Explorer Web3 method attachment; absent from swap build. Dangerous method namespaces could traverse object prototypes. | **Already patched:** reject reserved namespace segments and avoid inherited namespaces. Attack cases and normal attachment pass. |
| [GHSA-hhf6-3xpg-pggx](https://github.com/advisories/GHSA-hhf6-3xpg-pggx), `web3-core-subscriptions@1.10.3`, low | Explorer subscription attachment; absent from swap build. Same prototype traversal issue. | **Already patched:** the same namespace protections pass installed-package regressions. |
| [GHSA-848j-6mx2-7j84](https://github.com/advisories/GHSA-848j-6mx2-7j84), `elliptic@6.6.1`, low | Present in browser signing dependencies. Ophis also creates a local quote-only wallet; user order signatures use wallet providers. A blanket claim that cryptographic code is unused would be wrong. | **Already patched:** preserve nonce byte width before truncation. Independent P-521 expected-signature vector and Ethereum sign/verify/recovery checks pass. No patch to cryptographic code was needed in this turn. |
| [GHSA-w5hq-g745-h8pq](https://github.com/advisories/GHSA-w5hq-g745-h8pq), `uuid@3.4.0`, moderate | Legacy request dependency uses the v4 deep import. The swap build contains uuid 11.1.1, not the flagged v3 package. | **Already patched:** legacy v1/v3/v4/v5 reject invalid output bounds before writing. Tests check valid buffers, invalid offsets, short buffers and unchanged bytes after rejection. |
| [GHSA-j6r3-76f7-8jcv](https://github.com/advisories/GHSA-j6r3-76f7-8jcv), `ip-address@10.5.1`, moderate | Trezor → blockchain-link → SOCKS dependency. No subnet-membership allowlist calls found in its consumer. No ip-address source appears in the swap build. A future direct mixed-family allowlist call would have been unsafe. | **Fixed now:** upgrade to **10.7.1**. Cross-family membership is rejected and same-family membership still works. |
| [GHSA-h3mg-xc3c-68pw](https://github.com/advisories/GHSA-h3mg-xc3c-68pw), `ip-address@10.5.1`, moderate | Oversized invalid input produces excessive diagnostic output. The reviewed SOCKS text conversion uses `node:net` validation; response parsing uses fixed-size address bytes. No exposed attacker-controlled long-string constructor path identified. | **Fixed now:** upgrade to **10.7.1**. A 1 MiB invalid input rejects with bounded diagnostics; IPv6 classification and conversion compatibility checks pass. |
| [GHSA-p98j-92pf-mc4p](https://github.com/advisories/GHSA-p98j-92pf-mc4p), `dompurify@3.4.13`, low | Bundled through jsPDF's optional HTML support. Ophis receipts use `text()` and PNG `addImage()`, not in-place HTML sanitization or node-removing afterSanitize hooks. The advisory's exploit conditions were not found in application code. | **Fixed now:** upgrade to **3.4.16**. Both afterSanitize hook variants strip event handlers from detached subtrees; ordinary safe markup still sanitizes correctly. |

These exposure conclusions are scoped to the inspected callers and build. New
runtime pattern APIs, new HTML hooks or future dependency replacement would need
fresh review. A controlled validation error still needs normal error handling;
the braces patch prevents stack exhaustion, not every possible resource-exhaustion
pattern in a general-purpose expansion library.

## Changes and provenance

Base commit: `1e923ab7c9a888b978510fabdfbd2f65be7713e1`. All changes remain uncommitted
on `local/asset-swap-20261004`; the user's existing AssetSwap changes were preserved.

| File | Change and reason |
| --- | --- |
| [package.json](../../package.json) | Raise DOMPurify's minimum override to 3.4.16, pin ip-address 10.7.1, register the braces patch. |
| [pnpm-lock.yaml](../../pnpm-lock.yaml) | Resolve those two upgrades and bind every braces parent to its patch hash. No importer changes or unrelated version changes relative to the start of this turn. |
| [braces patch](../../patches/braces@3.0.3.patch) | Backport the nesting/cycle protections to the published 3.0.3 grammar. |
| [advisory regression checks](../../scripts/test-advisory-remediation.cjs) | Six installed-package tests for the newly remediated behavior and compatibility. |
| [existing security test runner](../../../../scripts/test-security-dependencies.cjs) | Invoke those checks in its frontend mode, already run by frontend CI. No workflow changes. |
| This report, its evidence JSON and the original audit's correction | Preserve the per-advisory assessment and distinguish patch verification from scanner output. |

The five existing package patches were introduced in security commit `ee010d31`.
The previous braces exception and caller review are recorded in
[the October 4 assessment](../../../../audit/dependency-review-2026-10-04.md).

The braces backport follows [contributor PR #72](https://github.com/micromatch/braces/pull/72)
at `28d440b5dd449dbf1fe6f3506cf94ecca4d02660`. It is **not a released or merged upstream
fix**; the PR is closed. Its branch also contains unrelated quote parsing and
invalid-brace changes. Those were excluded after the independent review identified
a quote compatibility regression in the initial copy. Regression tests now cover
both unpaired quotes and a closing quote preceded by two backslashes.

The release sources for [ip-address 10.7.1](https://github.com/beaugunderson/ip-address/releases/tag/v10.7.1)
and [DOMPurify 3.4.16](https://github.com/cure53/DOMPurify/releases/tag/3.4.16) match
the advisory fix versions and the registry integrity values recorded in the lock.
The existing one-week release-age policy was retained.

## Validation and review

- Before changes, the new checks reproduced both ip-address defects, DOMPurify's
  retained detached event handler, and missing braces nesting limits.
- Final dependency runner: **18 existing check groups plus 6 new tests pass**.
  Its existing checks verify all five previously applied security patches.
- **764 tests from the released braces 3.0.3 suite pass** against the final
  backport. The initial contributor-branch suite passed 904 tests, but those results
  alone did not detect its change to the released quote grammar; the final result
  relies on the release suite plus the new compatibility regressions.
- **37 frontend tests and 34 wallet tests pass**, covering quote signing, receipt
  helpers, swap reversal/AssetSwap integration and wallet behavior.
- **13 browser cases pass** across 320, 390, 768 and 1440px, both themes, nested
  token/network pickers, keyboard focus and reduced motion. No wallet connection,
  transaction submission or live RPC call was performed.
- TypeScript, changed-script ESLint, JavaScript syntax checks, `git diff --check`
  and a frozen-lockfile installation pass.
- Production build passes with the repository CI setting
  `NODE_OPTIONS=--max-old-space-size=6144`. The first attempt hit Node's default
  heap limit; no application change was made to address that environment failure.
- Inspected **138 generated source maps**: braces, ip-address, request and both
  vulnerable Web3 modules are absent; DOMPurify 3.4.16 and patched elliptic are
  present. The only bundled UUID version found is 11.1.1.
- Independent Codex review (gpt-6-astra, read-only) found **no remaining actionable
  defects** after the quote-parser correction. It inspected code and resolution
  evidence; the implementing agent ran the executable checks.

No numerical coverage percentage is claimed. No physical hardware wallet, live
trade, Explorer end-to-end session or other workspace's production build was tested.
Source-map absence is build-specific evidence, not proof about every other app.

## Scanner maintenance and reproduction

The existing frontend braces exception expires **2026-10-18**. It was not extended.
Its scan will continue flagging 3.0.3 despite the verified source patch; re-review
the gate by that date and replace the backport when a compatible fixed release
becomes available. Other workspace exceptions remain outside this remediation.

From the repository root:

```sh
node scripts/test-security-dependencies.cjs --workspace frontend
```

From `apps/frontend`:

```sh
pnpm install --frozen-lockfile
pnpm audit --prod --json # expected: six alerts for patched package versions
node scripts/test-advisory-remediation.cjs
pnpm exec tsc --noEmit -p apps/cowswap-frontend/tsconfig.app.json
NX_DAEMON=false pnpm exec nx run cowswap-frontend:test --testPathPatterns 'getBridgeQuoteSigner.test|mevReceipt/services|AssetSwapFields.test|useOnSwitchTokens.test' --runInBand
NX_DAEMON=false pnpm exec nx run wallet:test --runInBand
NODE_OPTIONS=--max-old-space-size=6144 NX_DAEMON=false pnpm build:cowswap
```

The [machine-readable evidence](dependency-remediation-2026-10-05.evidence.json)
records all nine dispositions, raw before/after counts, lockfile comparison,
active patch hashes, production module paths, independent review and source hashes.
Command logs are in `/private/tmp/ophis-dependency-review-20261005`.
