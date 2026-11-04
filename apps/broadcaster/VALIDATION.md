**Policy update, 2 November 2026:** the owner requested PPOI removal. The current SDK policy accepts confirmed unspent notes without list verification, preserves normal transaction proofs and authenticated gas reimbursement, and verifies exact received fee notes after confirmation. Earlier PPOI interface results below remain historical; they do not describe the current policy. The PPOI-free flow has separate test and deployment evidence under the current pilot record.

# Local broadcaster validation


## Release candidate — 4 November 2026

The latest backend source checkpoint is `f0e0d746743046a430da5f007fd668e6ba5ddb47`, with current Ophis main `a46e940fd1453de9294ee77aee3f8d460ff130e1` merged. This includes #1623, #1624, #1626 and the subsequent #1627 rebate fix. The original dirty checkout, encrypted browser formats, saved proofs, live journals and historical pilot marker remain preserved. The candidate is staged on Baal; the live pilot has **not** been replaced and public mainnet admission requires explicit configuration and all existing financial/signing safeguards.

| Final check | Evidence |
| --- | --- |
| Broadcaster | 151 tests, standalone typecheck and production build pass; the optional Waku test also passes separately through an isolated real nwaku relay |
| Private client | 308 tests and browser/Worker typechecks pass; 12 optional fork/live cases remain skipped in that suite |
| Current Ophis frontend | 39 scoped public/private flow tests, typecheck, scoped ESLint and the production build pass against the frozen current lockfile |
| Production private runtime | Mainnet build with `/private/` assets and the existing Ophis WalletConnect project passes and stages into the actual Ophis build |
| Real-proof protocol run | Two unrelated wallets complete two swaps and four withdrawals; six signatures produce six protected writes, six received fee notes authenticate through an independent real view-only SDK wallet, and a wrong transaction hash is rejected |
| Spending controls | Fresh-rate underpayment and re-encrypted consumed-spend replays require no additional signature; delegation-change simulation is rejected; receipt expenses equal the native gas balance decrease |
| Browser persistence | Both fork wallets reload with the same encrypted identities; cold synchronization is 139/124 seconds from cached public responses and warm reload is 16/4 seconds; these are not live first-use timings |
| Operations | Finalized-loss resolution, retained gas expense, restore, metric-label validation and atomic textfile replacement pass; the actual CLI emits only valid metrics with a disconnected real RPC provider |
| Custody | Dummy-key terminal checks pass for cancel, Enter, Ctrl-C and SIGTERM; noninteractive phrase recovery is refused before key access; no real fee mnemonic was displayed |
| Security | Fresh Semgrep has no parse errors and three reviewed false positives (generated guard bytecode and a readable UI summary); repository-configured changed-source secret scanning has zero findings |

The exact candidate bundle is `6dd1f655012c82e1098afb58424266dc36d7dca3ddd68984e49c5b3b83a1ef2f`. Image `ophis-broadcaster:release-637602ca0c1c15c7` is built on Baal, digest `sha256:da29919be79e8ede4c8acab56005049c3b17a1dd362fb3fd8609fdfc7d9197e7`. Its disposable fork CLI initializes successfully with networking disabled and without mounting production state. Required Docker-context files, excluded canaries and external SDK state are verified.

Claude's readiness-race and terminal-interruption findings are fixed with reproduced regressions. Its final monitoring finding was also reproduced against the pinned ethers provider: network-detection output polluted metrics when RPC failed. Only monitoring now pins the provider network, checks the actual raw `eth_chainId` separately and passes the real disconnected-CLI regression. Jev's source checks included uncertain and contradictory results; they are retained as review input, not represented as approval. The unchanged guard retains fresh hosted Solidity tests and its preceding Slither result; no formal verification is claimed.

Hosted broadcaster/client/security/CodeQL/CI checks passed at `b3b24dda840b4d7a561e610a7813df573b4e70fe`; hosted frontend tests and both production-build steps have passed. Later monitoring, parallel history-fetch and bounded-dialog changes have complete local tests and need their fresh hosted runs after publication. Both final standalone frozen installs pass, with upstream dependency versions unchanged. Independent V2 histories now fetch concurrently, matching the SDK V3 pattern, and a failed stream still rejects the whole history result. Progress is preserved during wallet opening; Merkle-root/proof verification remains required. The combined production preview passes with real WalletConnect pairing, cancellation/retry, disconnect, encrypted-wallet reload, actual CSP/cache headers, analytics exclusion and ordinary public navigation. No transaction request is made. Fresh network synchronization measured 382 and 533 seconds; the saved wallet opens in 3 seconds and reloads in 2 seconds. First use still takes several minutes; cached-fork timings are not substituted for these live-read measurements. Desktop, portrait and landscape QR dialogs also pass real-pointer cancellation checks. Actual rollout remains a separate recorded step.

Live read-only preflight found two settled requests, no unresolved request, matching latest/pending nonce 3, an undelegated gas account and the exact reviewed operator-bound guard. The native gas balance is `0.003228908919581249 ETH`, above the existing 0.003 ETH refill target. Gas prices exceed the unchanged 0.5 gwei cap. An online critical-state backup was copied off-server and authenticated without writing a plaintext backup, and the actual Prometheus installation accepts both prepared alert rules. No monitor cron/rules or candidate service upgrade have been activated yet.

The protocol fork uses a frozen initial oracle snapshot, modeled gas suggestions and receipt-based backend settlement; the independent fee-history decoder is real, while `fullWalletHistoryAssurance=false` remains explicit for the fixture's backend. No new Flashbots mainnet inclusion, live failing transaction or paid collection/refill was performed. An included outer revert can still spend operator gas without a fee; the durable hold and approved limits contain that exposure rather than guarantee reimbursement.

Evidence and exact manifests: `~/ophis-railgun-evidence/release-20261104/`. Dated sections below describe historical checkpoints.

## Repeated-user admission checkpoint — 4 November 2026

Stage 3 is implemented and validated locally, based on integration commit `44f27966876b6920dd921e1f0e314d286c9d237f`. The original dirty pilot checkout is preserved. Public mainnet startup remains explicitly held in source; no service, production state, keys or funds were changed.

- 117 backend tests and 287 client tests pass, with both projects' builds and browser/server typechecks passing. Thirteen optional unit-suite integration tests remain skipped.
- A separate six-minute real-proof fork run used two distinct new private wallets: two swaps and four withdrawals covering WETH, USDC and USDT. Six operator signatures produced six protected writes, zero signed writes reached the read connection, and every request was settled. The old pilot marker survived a request-journal reopen.
- Original-envelope duplicates returned their saved hashes. Re-encrypted consumed spends reached EVM/authority rejection after settlement, without another signature. A valid proof was first rejected under higher fresh fee rates without signing, then accepted with the original rates and same proof. The delegation-change comparator reproduced the unguarded unpaid no-op; the guard rejected it before publication.
- Each authenticated private fee covered the full signed gas budget plus 15%. The receipt-based expense ledger exactly matched the operator's native balance decrease, within the unchanged 0.0015 ETH daily ceiling and 0.5 gwei price cap. These are test-fork quantities, not live cost estimates.
- The first fork attempt exposed a real client/backend pricing mismatch: the node suggested seven wei while the broadcaster required base fee plus a positive tip, eight wei. WETH was rejected before signing. The client now applies the same floor before fee estimation; its regression fails before the fix and passes after it. No extra gas padding or lower reimbursement requirement was introduced.

The fork uses a frozen initial oracle snapshot, a modeled zero-tip suggestion and authenticated confirmed fee commitments. It explicitly reports `fullWalletHistoryAssurance=false` and no live protected-inclusion claim. A request-journal reopen is not a full service/custody restart. Both new wallets still needed 140/138 seconds to synchronize from cached public history; reducing this first-use delay remains part of stage 4.

The rebuilt amd64 bundle is `0d090a789bb953bb4b268e117a294d53d20c955a8e1610c4ded93d97de8b11d7`; local image ID is `sha256:620f241d5f6fa5a8e1128f02350e119344bf05e7c5fa525fcbce1b72ca1816e3`. Its unfunded fork CLI smoke test passes without networking. Source/unit checks isolate the public-mainnet hold; the actual image refuses that configuration with a sanitized error and contains the verified bundle.

Claude's initial review findings on release gating, rejection-test isolation and replay controls were fixed. Its follow-up reports no remaining blockers in the supplied scope. The cancellation-hold concern was disproved by the preserved receipt branch and a new regression. Jev supported five preliminary bounded claims with limited confidence; direct source checks, executable controls and Claude review provide the closure evidence. Ponytail kept the change to admission, settlement protection and the reproduced tip-floor bug. No formal verification or full audit certification is claimed.

Evidence is under `~/ophis-railgun-evidence/admission-20261104/`. Hosted CI/CodeQL, full operator-history/final roundtrip acceptance, monitoring/hold resolution and hosted Ophis UX remain pending. The unchanged guard retains the preceding checkpoint's artifact, Solidity and Slither evidence. Included outer reverts can still consume operator gas; the new hold stops subsequent spending rather than reimbursing that loss.

Semgrep reports zero findings and no production parsing errors. One pre-existing partial-parsing warning covers three generic-import spans in a test mock; those lines are unchanged and the test passes TypeScript and execution checks. Changed-source scans with default and repository secret rules report zero findings.

## Dependency integration checkpoint — 4 November 2026

The funded restricted swap and USDC withdrawal were confirmed on 3 November, including authentication and decoding of the exact owned broadcaster fees. This checkpoint integrates current main's security changes with that pilot source; public admission and deployment of the updated dependency image are still pending.

Fresh local checks: 95 backend tests pass (one optional Waku test skipped), 286 client tests pass (12 optional integration tests skipped), both projects typecheck/build, and the guard artifact reproduces with ten passing Solidity tests including 1,024 nonce fuzz cases. The frozen broadcaster install succeeds with the new lockfile. Its HIGH/CRITICAL dependency gate passes with exact-version-scoped patched exceptions; see [DEPENDENCIES.md](DEPENDENCIES.md). The actual Linux amd64 production image builds and its disposable fork-mode CLI starts successfully with networking disabled and no production state. Historical counts and launch states below describe their dated checkpoints.

### Source and image manifest

| Item | Integrated checkpoint |
| --- | --- |
| Current main, fetched again 4 November | `d5c7486a91becebb6120f0f927af08638107564b` |
| Original feature head, preserved with its dirty checkout | `f6792c6932f750cb433ee5193d17b659fc84eac4` |
| Clean committed-source merge tree before the pilot overlay | `ef4f0d952a393c868e07e08ec38950cb6d0ffa82` |
| #1623 security dependency merge | `c14f362464e2faad2b1b5a0f661518bf41e3dec3` |
| #1624 supply-chain merge | `6ebb212aa65fc8100a4ecc8a5cd351318c27b9eb` |
| #1626 CLI packaging merge | `d5c7486a91becebb6120f0f927af08638107564b` |
| Broadcaster application bundle SHA-256 | `db0e3348a8c6db4b93677deba00907e3794304e25865bb434b4ecb0cf246093d` |
| Rebuilt Linux amd64 image ID | `sha256:b34b90e01651c9a11d22c4f8b816be0bd7d3ce0d9db59a7c9c175bb52e08a09e` |

All 88 files in the pre-integration dirty/untracked source checkpoint are present. Intended changes to that snapshot are dependency/package-manager configuration, Docker packaging/context, regression tests, CI/audit/update coverage and documentation. Broadcaster application sources, guard source/artifact and persistence formats are preserved. The application bundle matches the pilot; its external dependency tree changed and has separate validation. The full file hashes and test/review logs are retained in `~/ophis-railgun-evidence/integration-20261104/`, including `integration-source-manifest.json`.

### Review closure and additional checks

- Ponytail's smallest-complete-change approach kept this slice to integration and dependency/security coverage. No production admission, wallet state or financial configuration was changed.
- Claude reviewed the dependency plan and final delta. Its Docker-context finding is fixed: only file-level exceptions remain. A real Docker test verifies required files, excluded private/unrelated canaries and a deliberately broadened negative control. The image was rebuilt and smoke-tested after that fix.
- Claude's boundary-test coverage question is resolved by the existing root `ci.yml` PR job. Five workflow-boundary tests pass. The actual security-workflow exact-version guard passes both project fixtures and rejects a missing zod patch in both negative controls.
- The five dependency regressions pass through the actual CJS/ESM URL-loader caller, assert both patched GraphQL-utils versions, and load the SDK's own zod consumer. These checks close the corresponding review gaps.
- Jev checked five bounded claims against supplied source/evidence. Four results had limited confidence; direct source inspection, the image tests and gate negative controls provide the supporting evidence. Model responses are not release approval or security certification.
- Fresh Semgrep scanning of the changed production/configuration scope reports zero findings or parse errors. Fresh Slither 0.11.5 reports only the informational validated low-level call, with no High/Medium findings. Repository-configured secret scanning passes; generic full-tree rules also match historical fixture/address/hash data and are not described as a clean default-rule scan.

Hosted CI and CodeQL have not run on this branch. Thirteen optional Waku/fork/live tests remain skipped in this checkpoint; the final integrated roundtrip and hosted/public-swap checks remain release work. The updated image is local only. No service, persistent state, signed transaction or funds were changed during this integration. An included outer revert still exposes operator gas despite the validated fee and limits.

## Custody update — 2 November 2026

The no-subscription custody release is installed on existing Baal infrastructure. AWS/KMS is withdrawn and no paid account or service was provisioned. A fresh software gas key and rotated wallet-database key are encrypted at rest under the existing backup certificate. Only its public certificate is on Baal; the recovery private key remains on the owner's Mac. Runtime keys are manually unlocked over SSH into a private container Unix socket. Restart was verified to return to `locked:true`; manual re-unlock succeeds. The service remains unarmed with zero financial limits. A compromised host can spend the unlocked online gas balance despite application budgets. No funds moved or network transaction was submitted.

The Ambire + Ledger treasury/refill address is `0x58707c6C1E111c21cba4C9C8caE144175F84EceE`; its checksum is valid. Public reads do not prove device ownership. The separate replacement gas account is `0x65C3f921DB6f0e431C28EcbECFA7687fbD68f2a8`. The old gas account and funding/deployment packet are retired. The running private fee wallet is now view-only, with the same receiving address. Its mnemonic and former database key are excluded from the runtime unlock record and retained in encrypted recovery material. The legacy plaintext operator file was removed only after fresh full backups and both encrypted key records were verified off-server. Prior copies and a historically hot seed are not erased by this migration.

Transaction signing checks the returned sender and canonical unsigned transaction body before persistence/publication. Tests exercise exact type-1/type-2/type-4 signatures, changed fields, a wrong signing key and mutation during signing. Mainnet unlock rejects fee mnemonics and an unexpected gas key. The actual pinned SDK tests verify fee-note decryption and signed advertisements through a view-only wallet. Migration/restart tests preserve the fee address and reject access to a fee-spending mnemonic. This does not establish hardware custody of the gas key or independent policy enforcement. See [operations](OPERATIONS.md#custody-migration).

Validation passed: 67 backend tests, TypeScript checking, main and standalone unlock-client builds in bounded network-isolated Linux containers using dummy keys. After setting the GCM tag length explicitly, all eight custody regressions passed again. One optional Waku integration test was skipped. Fresh source-only Semgrep scanning covered 16 production files with zero findings or parse errors after that fix; ShellCheck passed. macOS sandbox-exec aborted before those trusted static tools started, so those parsers were run against the sanitized source with a clean environment and no target-code execution; the static runs do not claim OS network isolation. Executed application tests/builds remained in network-isolated Linux containers. Earlier Slither and CodeQL results are historical; no new formal verification is claimed. Evidence is under `~/ophis-railgun-evidence/local-custody-20261102/`.

The real service synchronized successfully after its first unlock. A fresh 590,459,515-byte full backup and a 62,065-byte online critical-state backup were copied off-server and authenticated with OpenSSL 3 without plaintext backup files. The daily backup now snapshots live SQLite journals and encrypted records without stopping/relocking the service. Its restore requires wallet-history resynchronization; optional full backups retain the cache and require manual unlock after restart.

## Historical launch checks — 1 November 2026

At that check the broadcaster and nwaku were deployed on Baal, synchronized, and unarmed. A dedicated file-based gas wallet and separate private fee wallet existed with verified encrypted off-server backups. The gas wallet had zero ETH. No guard deployment or signed mainnet transaction had been submitted, and the frontend protected allowlist remained empty. Mainnet preparation required a configured owner-controlled pilot account with a verified operator-bound guard, a positive markup and explicit financial limits; the new custody hold above now supersedes that preparation.

## Historical launch checks — 1 November 2026 (continued)

| Check | Result |
| --- | --- |
| Node 22 Linux broadcaster suite | 41 passed; 1 optional isolated-Waku integration test skipped |
| Node 22 Linux client suite | 274 passed; 12 optional fork/live tests skipped |
| Builds and typechecks | Backend bundle, frontend build, browser TypeScript and Worker TypeScript passed in bounded, network-isolated Linux containers |
| Financial boundary | Positive markup required when enabled; client and server round up fee-token reimbursement; real signed gas ceiling and fresh price checked before signing |
| Recovery and client hardening | Restricted pilot admission, stale preceding transport-journal recovery, tree-qualified receipt inputs, atomic COMMON private/public handoff, and dev/preview RPC origin/JSON gates passed regressions |
| Fresh static review | Semgrep: 184 baseline rules/160 paths plus 57 Solidity rules/2 files; 9 false positives and 2 unchanged non-security gas suggestions, zero new confirmed security findings; 1 incompatible rule and 16 test parsing gaps, no production parse errors |
| Backup script | ShellCheck clean; isolated encrypt/restore and failure cleanup/restart controls passed |
| Linux deployment | Frozen production dependencies installed without lifecycle scripts; non-root read-only image, private state, CPU/memory/process limits, local health and Waku readiness verified |
| Cold start and restart | Mainnet history synchronized; clean backup/stop/restart preserved both gas and fee identities, zero pending requests and zero health errors |
| Actual backups | Real operator secrets matched after decryption; full 596,798,075-byte encrypted snapshot copied off-server and its GCM authentication verified without a plaintext backup file; daily backup cron installed |
| Read-only on-chain preparation | Dedicated gas address undelegated and unfunded; canonical delegate registry checked; nonpayable guard deployment estimated and left unsigned; live pricing feeds accepted |

Current private evidence is under `~/ophis-railgun-evidence/launch-20261101/`, including source/release manifests, exact image and bundle hashes, scanner results, test commands/limits, backup verification and the unapproved funding/deployment packet. Source contains no production private keys. Fresh Semgrep review covered the final receipt and withdrawal changes. Earlier Slither and CodeQL results remain historical snapshots; the Solidity guard source and artifact are unchanged. No new formal verification is claimed.

The proposed 15% markup and 0.003 ETH pilot funding envelope have not been approved or activated. Client fixes are prepared and tested; a public frontend activation has not occurred. Older separable-fee proofs already disclosed by a previous client cannot be revoked by a client update; the record remains available for reconciliation/manual recovery and unsafe rebroadcast is blocked.

## Earlier proof and contract acceptance

These checks precede the current client receipt/fee hardening. They establish the unchanged guard and protocol/transport fixture behavior, rather than a new funded acceptance of this exact release.

| Check | Result |
| --- | --- |
| Broadcaster suite with isolated real nwaku relay | 39 passed, no skipped tests |
| Railgun client suite with Ethereum swap/cancellation fork tests | 267 passed, 8 optional tests skipped |
| Protected-sender execution and cancellation fork tests, run separately | 2 passed; these are two of the preceding optional skips |
| Reproducible guard artifact and Solidity tests | 10 passed, including 1,024 exact-nonce fuzz runs |
| Cold real-proof browser roundtrip | Passed: local ETH shield, encrypted request, guarded execution, increased private USDC |
| Warm roundtrip through the actual protected sender | Passed: both durable journals, one intercepted private write, zero signed writes on the read connection, authenticated private fee commitment in the successful receipt |
| Malicious authorization change after validation | Unguarded comparator reproduced a successful unpaid no-op; guard rejected it with `UnexpectedDelegate` and no guarded transaction was published |
| Startup/teardown failure handling | Deliberate browser-startup validation failure exited and recorded its state; late private writes after sender shutdown were blocked with zero network calls |
| Installed SDK against live PPOI read interfaces | Required-list/TXID roots passed positive and zero-root negative controls; synthetic nonexistent commitment returned Missing |
| Baal and protected endpoint reads | Correct Ethereum chain; Baal synchronized and supports call tracing; configured protected endpoint responds |
| Builds and typechecks | Broadcaster build/typecheck and Railgun browser/server typechecks passed |
| Production dependency audit | 0 critical, 6 high, 2 moderate, 1 low version-based advisories remain; existing patches/reachability assessment are recorded separately, and this is not a clean audit |

Four successful real-proof runs used a disposable Anvil Ethereum fork on loopback, with fresh generated test wallets and test ETH only. The cold run preceded the protected-transport fixture; the subsequent three used the actual protected sender. The final run's transaction was `0xb08cc96d98202e38ac5da3bfdb4049d7d14a8745d73fb810d8f340e69e99370c`, guard `0x7468Fec753bEc6993A49462D3E3B0e7b6618D5f7`; neither is a mainnet deployment/submission. Its exact paid commitment was `0x12a46d4f8df6612cb2a45ea7015375b170d78a2cbbd6f10fcb5d11c585b9d2a1`. All successful harness processes exited zero after cleanup; the pass marker alone is not used as completion evidence.

The final attack comparator spent 145,880 test gas units and produced zero fee logs after delegation was cleared. The guarded call reverted in simulation with `UnexpectedDelegate`; its counterfactual failing transaction was not submitted. This proves the observed no-op path is rejected. It does not prove an external builder's inclusion policy.

## Historical activation boundary — 1 November 2026

Local fork notes have no live PPOI entries. The fixture intentionally disables only that external requirement, verifies the actual private proof on the fork's contracts, and retains explicit `livePPOI=false` and `liveProtectedInclusion=false` result fields. Root/health checks through the real SDK are not a claim that this operator has received and assured a spendable mainnet fee.

Custody migration is complete. Funded activation still requires a replacement operator-bound guard packet, owner approval of markup, total funding budget and funding source, guard deployment/runtime attestation, exact live fee/PPOI assurance and protected type-4 inclusion under the restricted pilot, dependency-risk acceptance and an explicit public release. Review the real fee identity and running deployment before changing the Ethereum frontend allowlist or lifting pilot restrictions. No deliberately failing mainnet transaction is required to test rejection.

The RAILGUN payment model fronts native gas and collects the user's private fee inside execution. If a whole transaction is included and reverts, gas can still be charged while fee delivery is rolled back. The guard and private no-revert policy provide practical protection under their assumptions; this release does not claim unconditional user-funded reimbursement.

Detailed private receipts, source hashes, test logs and dependency observations are retained in the local evidence directory. No secrets or executable signed transactions are part of this document.
