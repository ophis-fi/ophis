# OTC canary preparation review — 2026-09-07

Status: reviewed default-off canary preparation. This report does not approve production activation or funded transactions. The checked-in policy has no admitted accounts or pairs and expires at zero. All browser/contract writes used local Anvil only, with keyless PublicNode upstream and zero RPC retries.

## Scope and conclusions

This review covers the ERC-20 canary frontend, wallet adapters, transaction uncertainty persistence/recovery, and network/policy boundaries added after `5dd6283c786a272818dbe5937c21746501e2cedc`. No Solidity changes were made. Implementation shipped in sequential PRs of at most 400 changed lines, each with fresh exact-head review and passing CI. The final interface/documentation PR uses the same merge gate.

A fresh frontend reviewer found concrete duplicate-submission paths during development. The final bounded re-review found no further concrete findings in the reviewed delta after the fixes below. That conclusion is not a claim that every security skill, specialist contract audit or production scenario has been completed.

## Findings corrected before release

| Finding | Correction and regression evidence |
|---|---|
| Optional admission can leave the canary action enabled before admission is known | Model inputs require explicit canary/admission fields and admit only `walletAdmitted === true`. False and unknown values stay blocked. Network-switch rejections/failures use switch-specific wording and the shared rejection classifier. Three regressions failed before the fixes and pass afterward. |
| Wallet block headers alone do not authenticate settlement `eth_call` results | Independent Ethereum client supplies order/allowance reads, simulation, nonce, transaction identity and receipts. Both legacy and Wagmi adapters are tested. |
| Canonical pending nonce can lag transactions known only to the wallet RPC | Require bounded wallet/canonical pending-nonce agreement before supplying an explicit nonce. Both signer paths reject lower and higher wallet nonces; stalled nonce reads fail within eight seconds. |
| A preflight block timestamp can outlive the canary cutoff during asynchronous checks | Recheck wall-clock expiry immediately before each signer call. Both adapter regressions advance the clock to the cutoff during nonce reads and verify that neither a marker nor a signing request occurs. |
| Adapter proof handoff was deferred past the adapter precursor | The shared sink now forwards proof to pre-sign persistence and receipt tracking, and rejects proof-bearing signing if no persistence callback was supplied. The regression verifies that the missing-callback path never sends. |
| An adapter can return a hash without invoking proof capture | Revalidate the captured fingerprint and safe nonce before receipt tracking, after recording the broadcast hash. Missing proof becomes a hash-bearing tracking error; the full writer retains that uncertainty. The independent follow-up passed 48 focused tests. |
| Recovery controller can accidentally reuse the fork verifier in canary mode | Ship canary recovery controls together with canonical network verification. Two controller regressions reconcile both stored and supplied hashes through the canonical network callback. Recovery fixtures use SDK account normalization and guarded nullable values. |
| Lost send response leaves no durable hash lock | Persist a nullable uncertainty marker immediately before the actual signer call. Storage failures stop signing. All post-prompt hashless errors, including 4001, retain the marker. |
| A malformed returned hash can corrupt uncertainty state | Validate a full 32-byte hash before replacing the nullable marker; invalid provider output stays locked. |
| Legacy bundles reject the new nullable schema and can erase shared state | A dated owning-module migration mirrors known hashes into v0 and rereads both keys under the original Web Lock and on either storage event. A newer legacy hash replaces stale v1 state; nullable v1 records remain protected. Old fork-only bundles cannot perform canary writes. Valid legacy removals resolve known fork locks without proof; missing/corrupt legacy snapshots cannot unlock v1. Nullable and canonical-proof locks remain authoritative in v1. |
| Unrelated or prior identical receipts can settle an uncertain attempt | Persist the exact reviewed request fingerprint and canonical pending nonce; include that nonce in both actual signer requests. Canonical receipt verification requires exact nonce equality plus sender, target, calldata and zero value. Tests reject both lower and higher nonces. |
| Stale recovery of attempt A can delete newer hashless attempt B | Every attempt receives a random 128-bit ID, preserved when its hash arrives. Compare the complete captured record under the browser lock before receipt verification and again before removal. Regression uses identical hash/null, timestamp and proof with distinct IDs. |
| An unresolved switch can strand a newly connected wallet and later overwrite its error | Reset switching on wallet/authorization context changes and unmount, and ignore stale request results. Four regressions cover Wagmi replacement, legacy replacement, context-only change and unmount; the independent follow-up passed all eight switch cases. |
| Canary network-switch action did not request Ethereum | Reuse the connected Wagmi or legacy network-switch API, with pending/error handling. Four switch tests pass. |
| Trading-expiry text implied pending prompts or orders expired | Notice explicitly separates new UI requests from already-issued wallet prompts and existing escrow orders. |

## Verification

- Focused Jest run: 49 suites, 410 tests pass; one optional live-network test skipped.
- Fresh reviewer independently ran five adapter/proof suites / 65 tests after the nonce and cutoff fixes: all passed, with one optional network test skipped. Subsequent bounded reviews passed 67 submission/recovery tests and six recovery-control UI tests. These reviews do not replace each PR’s exact-head GitHub review.
- Scoped ESLint and TypeScript application check pass; no touched non-generated TypeScript source exceeds 250 lines.
- Production build passes. The build emits a PWA precache/glob warning; successful compilation is not proof of offline caching. The same zero-precache/glob warning was present in PR #1311 before the larger candidate changes; offline caching was not tested.
- Seven deployed-contract ERC-20 fork invariants pass. No new contract deployment or funded Ethereum transaction was performed.
- Six injected-wallet lifecycle/recovery/accessibility flows pass in local canary mode in an isolated checkout. Its temporary public Anvil test-account policy and independent reader point only to local Anvil; they are not copied into production configuration. The first attempt failed two fork-only text expectations; selecting the correct canary notice made all six pass without relaxing assertions or timeouts.
- Semgrep OSS scan: `p/security-audit`, `p/typescript`, `p/react`, `p/secrets`; 125 applicable rules on 46 non-test source files, zero findings and zero reported errors, approximately 100% parsed. Tests/fixtures are excluded. New untracked sources are included with `--no-git-ignore`.
- Read-only canary script self-test and live identity/index health check passed earlier in this preparation; neither sends transactions nor constitutes wallet monitoring.

Evidence logs, Semgrep JSON, local rehearsal scripts/screenshots and candidate source snapshot are retained outside the repository under `/Users/scep/ophis-audit-evidence/2026-09-07/`. Merged implementation releases are listed below. Final served-asset provenance and disconnected production QA are retained with the deployment evidence.

## Reviewed implementation releases

| PR | Change | Squash commit | Deployment |
|---|---|---|---|
| [#1311](https://github.com/ophis-fi/ophis/pull/1311) | Empty admission policy | [`8326e84d85`](https://github.com/ophis-fi/ophis/commit/8326e84d858333e8df6418efae1b1054b2b207af) | [Workflow run](https://github.com/ophis-fi/ophis/actions/runs/34109213594) |
| [#1312](https://github.com/ophis-fi/ophis/pull/1312) | Fork identity | [`ea8c3b0ce0`](https://github.com/ophis-fi/ophis/commit/ea8c3b0ce0b435e25e43f697b9d64da0debef2ae) | [Workflow run](https://github.com/ophis-fi/ophis/actions/runs/34110020205) |
| [#1314](https://github.com/ophis-fi/ophis/pull/1314) | Bounded order reads and retained submission state | [`8840a19c47`](https://github.com/ophis-fi/ophis/commit/8840a19c47bba61aa8390ea3f801e30c3f06029a) | [Workflow run](https://github.com/ophis-fi/ophis/actions/runs/34119578251) |
| [#1313](https://github.com/ophis-fi/ophis/pull/1313) | Attempt proof and storage migration | [`bd2e34c71f`](https://github.com/ophis-fi/ophis/commit/bd2e34c71f3d7f89f8bfc9063256a5d883103b37) | [Workflow run](https://github.com/ophis-fi/ophis/actions/runs/34120234853) |
| [#1315](https://github.com/ophis-fi/ophis/pull/1315) | Canonical adapters and signing guards | [`2d255e2943`](https://github.com/ophis-fi/ophis/commit/2d255e29437f2c9e11439a90c296bf612f41474e) | [Workflow run](https://github.com/ophis-fi/ophis/actions/runs/34124376803) |
| [#1316](https://github.com/ophis-fi/ophis/pull/1316) | Captured-proof validation | [`1af20c9583`](https://github.com/ophis-fi/ophis/commit/1af20c958335a582b5f972ab8724492cebe25cf6) | [Workflow run](https://github.com/ophis-fi/ophis/actions/runs/34126991247) |
| [#1317](https://github.com/ophis-fi/ophis/pull/1317) | Recovery controls | [`05580201d3`](https://github.com/ophis-fi/ophis/commit/05580201d3cf09cc63cce00d24b4ed2a4abf08fb) | [Workflow run](https://github.com/ophis-fi/ophis/actions/runs/34148843974) |
| [#1318](https://github.com/ophis-fi/ophis/pull/1318) | Durable signature recovery | [`0d38f10500`](https://github.com/ophis-fi/ophis/commit/0d38f105002cf529efe2a0e2522dc03cbeddb7a5) | [Workflow run](https://github.com/ophis-fi/ophis/actions/runs/34150515917) |
| [#1319](https://github.com/ophis-fi/ophis/pull/1319) | Explicit admission and network switching | [`f92d7d9bdb`](https://github.com/ophis-fi/ophis/commit/f92d7d9bdb94ab51bbf02f8a25692612637988a9) | [Workflow run](https://github.com/ophis-fi/ophis/actions/runs/34152118966) |
| [#1320](https://github.com/ophis-fi/ophis/pull/1320) | Canonical network and recovery integration | [`cecdabb32b`](https://github.com/ophis-fi/ophis/commit/cecdabb32ba61e480a6ccfc08ff90cbdd06da5a1) | [Workflow run](https://github.com/ophis-fi/ophis/actions/runs/34152696404) |

## Remaining constraints

Production currently has no configured LaunchDarkly client key or verified runtime write-flag provider. The runbook requires that wiring and a witnessed shutdown drill before activation; changing the compiled write default is prohibited. The existing emergency control sets `REACT_APP_OTC_ENABLED=false` in the repository and rebuilds/deploys through the Cloudflare workflow. It affects the served bundle after deployment and reload, not already-loaded tabs or direct contract calls.

The trusted canonical RPC, trusted wallet honoring the requested nonce, and one-confirmation model remain assumptions. Do not edit the nonce or run competing transactions through another client. Browser locks do not coordinate devices/origins or survive deliberate storage deletion. An actually rejected prompt without a provable mined hash stays locked conservatively. Recovered approvals are terminal in the current view; reload and review fresh allowance before continuing.

The policy PR's initial CI fork browser run passed create/mobile but failed four order-detail flows while loading verified fork orders. PR #1311 passed on a rerun, and PR #1312 passed its browser job. Later query diagnostics reproduced eight-second read timeouts hidden by automatic retries. PR #1314 makes those errors immediately recoverable and hides stale terms/review controls after refresh failures. A follow-up P1 found that replacing the action panel could unmount an in-flight controller; the fix keeps that controller and its submission context stable. Three mounted regressions cover initial errors, stale-review blocking and retained pending state; the pending-state regression fails on the previous implementation and passes after the correction.

The previous [expanded audit](otc-expanded-security-review-2026-09-06.md) retains its specialist-review and dependency limitations. Full Verity/Pashov/Fizz contract reviews are not claimed here. Required activation inputs and witnessed production flag/rollback checks remain in the [operator runbook](../development/otc-canary-runbook.md). Native ETH and Safe/EIP-5792 batching remain deferred.

The final migration follow-up review found no further concrete lock-loss path after correcting legacy-only clear resurrection. Targeted checks cover stale A→B replacement, dual-key subscriptions, ignored stale event payloads, nullable-marker preservation, and cleanup. GitHub fork-browser runs intermittently stayed in the order-loading panel. Bounded diagnostics remain in the injected test provider for future failures.

The assembled candidate at `1c4ffecbb403dede0e253fac236246c02eff7c1f` passed the six-flow canary rehearsal in 1m35s after the nonce-agreement, signing-cutoff, required-persistence, captured-proof, wallet-switch context and explicit-admission fixes. Its production build and fresh Semgrep scan passed; the pre-existing PWA/glob warning remains outside this feature and offline use is not claimed. Policy injection was restricted to the disposable rehearsal checkout.

A subsequent fork-mode local run traced a failed USDC approval simulation to PublicNode HTTP429 responses. Background wallet balance multicalls were hydrating hundreds of unrelated tokens through Anvil. Restricting only the two default host token-list fixtures to WETH/USDC yielded six passing browser flows in 1m30s with no upstream429 errors. All OTC reads, simulations, sends and receipts still execute on the local fork. This establishes the cause of that simulation failure; it does not retrospectively prove the cause of every earlier CI timeout. Evidence is retained under `order-read-recovery/`.
