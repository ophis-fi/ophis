# RAILGUN broadcaster integration with current Ophis

Status: stages 1–3 implemented and validated locally, 4 November 2026. Stages 4–6 and production rollout remain pending.

Implementation checkpoint: stages 1–2 are implemented in `fix/railgun-broadcaster-security-integration` at `/Users/scep/ophis-railgun-integration`. The complete pilot snapshot is preserved; current main is integrated; backend frozen installation, dependency regressions, audit gate, Linux amd64 image build and disposable runtime smoke test now pass. Local evidence includes 95 backend tests, 286 client tests, both builds/typechecks and ten guard tests with 1,024 nonce fuzz cases. Five workflow-boundary regressions pass. Thirteen optional Waku/fork/live tests remain skipped. Hosted CI and the later production stages are not represented by these local results. Claude reviewed the dependency plan; Jev's claim checks support the bounded conclusions but include uncertainty requiring human/source review, not automatic release approval.

Stage 3 checkpoint: 117 backend and 287 client tests pass. Two distinct disposable wallets completed two real-proof swaps and four protected withdrawals across WETH, USDC and USDT; underpayment, consumed-spend replay and delegation-change controls passed without an extra operator signature. Settlement and fee holds survive restart, and the historical pilot marker is retained. A reproduced Ethereum positive-tip mismatch was fixed in withdrawal preparation. Mainnet/public startup remains blocked until final acceptance; these results do not activate the live service. See [current validation](../../../apps/broadcaster/VALIDATION.md#repeated-user-admission-checkpoint--4-november-2026).

## Objective and baseline

Deliver Ethereum private swaps and withdrawals through Ophis's own broadcaster as part of the current Ophis application, retaining the recent security updates and existing public-swap behavior. The selected fee flow stays inside the private transaction, with authenticated coverage of the maximum signed gas cost plus at least the approved 15% margin.

`origin/main` was fetched again on 4 November and remains `d5c7486a91becebb6120f0f927af08638107564b`, including #1623, #1624 and #1626. The original `fix/private-mev-protection` checkout at `f6792c6932f750cb433ee5193d17b659fc84eac4` and its uncommitted pilot changes are preserved. Work now uses `fix/railgun-broadcaster-security-integration`, based on current main. Recheck main before release if it advances.

Reference: [review of the three security PRs](../../../OPHIS_DIFFERENTIAL_REVIEW_2026-11-03.md).

Completed evidence:

- A restricted Ethereum swap and USDC withdrawal succeeded, and both broadcaster fee notes were independently authenticated and decoded.
- A combined source snapshot with main's new client dependencies passed 286 client tests, browser/server typechecks and the production build. Twelve optional integration tests remain outside that result.
- The committed development/main merge simulation is clean. The review reproduced a broadcaster frozen-install failure on a removed shared patch; stages 1–2 now repair that graph and its independent security coverage.
- Ophis already provides `/private-swap/`, the `/private/` runtime, private-document headers and frontend integration tests. Extend these existing pieces.

The production site's actual deployed commit must be recorded during release preparation. A fetched main SHA and a successful localhost pilot do not establish which build is currently served to customers.

## Work in dependency order

### 1. Consolidate the tested development onto current main

- Preserve a complete source checkpoint, including untracked contracts, custody/recovery modules, shared PPOI policy and generated guard artifacts. Do not merge or rebase over the dirty active checkout.
- Prepare an isolated integration branch containing current main and the complete pilot implementation. Preserve the owner-authorized PPOI removal, fee/gas fixes and recovery changes.
- Compare the resulting files with the tested pilot sources and record intended differences. Preserve encrypted wallet storage formats, pending records, account indices and the used withdrawal marker.
- Reconcile README, operations and validation records: distinguish historical unfunded/PPOI-required checkpoints from the successfully funded PPOI-free pilot.

**Acceptance:** a reviewable source/commit manifest accounts for every development file and all three security PRs; no wallet/journal reset or deployed-service change is needed to assemble it.

### 2. Fix broadcaster dependencies, packaging and security coverage

- Remove the broadcaster's obsolete executor 0.0.11 patch reference by updating its actual GraphQL dependency graph and frozen lockfile. Use the reviewed client upgrade as the compatibility reference, including GraphQL Mesh peer resolution.
- Align the broadcaster's pnpm integrity pin and Docker pin with main's reviewed 10.34.9 version. Add applicable fixed dependency releases and the zod 3 backport. Keep SDK consumers on their compatible zod major.
- Apply the seven-day resolution policy to this standalone project and include the necessary configuration and every referenced patch in its Docker build context.
- Add broadcaster-specific frozen-install, dependency-regression, test, build and Docker-image checks. Add its own dependency audit job; verify that advisory exceptions apply only to exact patched versions and are renewed or removed by their recorded expiry.
- Trigger those checks when shared patches, the shared PPOI policy, execution-guard helpers or their dependency files change. Preserve lifecycle-script restrictions and credential-free PR builds.

**Acceptance:** both standalone projects install from their real frozen lockfiles; the actual broadcaster image builds from the integrated source; the backend dependency gate passes under a documented Node-service assessment. The two findings in the PR review are closed with evidence.

### 3. Complete production admission and repeated operations

- Replace admission tied to the single pilot account, pinned recipient and one withdrawal with reviewed production admission for repeated operations. Retain historical pilot records rather than deleting the used marker to unlock service.
- Support the already selected Ethereum token set consistently in quotes, proofs, withdrawal checks and fee accounting. Ensure the UI cannot prepare a token/recipient combination the server will reject solely because of leftover pilot restrictions.
- Keep authenticated fee commitments, fresh conversion rates, maximum-gas-plus-margin coverage, current base-fee handling, private-only submission and the deployed operator-bound guard.
- Keep one unresolved gas nonce, durable journals, duplicate-request protection, finite admission limits and conservative availability. Multiple users may be served sequentially; extra funded gas wallets are not a prerequisite.
- Make expired quotes, busy service, exhausted budgets, restart, unknown submission outcomes and saved-proof retries predictable. Never create another spend to work around an unresolved transaction.

**Acceptance:** repeated swaps and withdrawals from separate disposable wallets succeed in the isolated integration environment; replay, underpayment, unsupported requests and authorization changes are rejected without an unnecessary signed transaction. Existing pending records still reconcile correctly.

**Local acceptance passed.** The protocol fork checks authenticated received commitments with a frozen initial rate snapshot; full operator history and live-builder acceptance remain stage 6 work. Enabled public mainnet startup retains an explicit source hold.

### 4. Finish the existing Ophis user flow

- Use the existing public/private navigation and private runtime. Keep RAILGUN's dependency graph separate from the ordinary frontend; avoid changing the main application's libraries merely to satisfy the private SDK.
- Bind the verified Ophis fee identity to the Ethereum protected-broadcaster configuration, using an explicit review expiry. Replace the temporary localhost trust configuration through the release configuration.
- Connect the existing WalletConnect setup, trusted RPC gateway and resource-budget controls to the final deployment. Verify that fee discovery works before inviting a deposit or generating a proof.
- Reduce and clearly expose first-use history synchronization before inviting a deposit. The stage 3 wallets needed 140/138 seconds even with cached public responses; preserve proof/Merkle verification while improving startup and retaining existing wallet caches.
- Present deposit, private swap, private balances, withdrawal and saved-transaction recovery with clear fee/amount summaries. Display WETH accurately when the user holds or receives wrapped ETH.
- Preserve private-document navigation, CSP, analytics exclusion, validated frame messages, and protection from destructive cache/storage migrations. Verify the combined main-app shell and private runtime; an iframe alone is not proof of key isolation.
- Keep ordinary Ophis quotes, approvals, public swaps, wallet connection and network navigation covered by regression checks. Public/private switching must remain safe while a private operation is pending.

**Acceptance:** a fresh browser and an existing encrypted wallet can use the hosted Ophis flow without the SSH pilot tunnel; normal public-swap regressions pass on the same release. First launch of this operator is Ethereum only; existing ordinary swaps on other networks remain covered by their normal tests.

### 5. Complete fee collection and operations

- Prepare owner-controlled collection of earned private fees, conversion/unwrap into ETH where required, and bounded gas-wallet replenishment. The online fee wallet remains view-only; collection must not place its spending mnemonic or treasury authority in the broadcaster service.
- Use existing Baal infrastructure and Ambire + Ledger treasury control. Batch collection when appropriate, and calculate collection, conversion and refill costs before recommending a sweep. Check that the fee policy remains profitable after these costs.
- Define low-reserve, stale-node/price, missing-fee-assurance, pending-nonce and unavailable-service monitoring. Prepare alert delivery through the existing selected mechanism; no new paid service is assumed.
- Prepare and test owner-reviewed resolution of confirmed unpaid/unknown holds with an audit reason, preserved signed records and retained gas expenditure. Ambiguous outcomes stay held; never clear a row or claim a missing fee was paid to restore availability.
- Retain encrypted off-server backups, manual unlock after restart and documented recovery. Test restore/reconciliation in a disposable installation before relying on it operationally.

**Acceptance:** an operator can reconcile received fees and native gas expenditure, prepare a costed collection/refill action, and recover the service from its backup. Tests and preparation do not require a new user deposit or an automatic treasury refill.

### 6. Validate and release the exact integrated build

- Run client, broadcaster and applicable main-frontend tests against the final lockfiles. Include real fee-note authentication, gas rounding/floors, repeated users, duplicate requests, cold/warm starts and unknown-outcome recovery.
- Run the actual proof/guard/protected-transport roundtrip on a disposable fork, including malicious delegation-change and fee-underpayment negative controls. Enable the relevant optional tests rather than treating their earlier skips as coverage.
- Review the final change set and dependency dispositions. Run Semgrep and applicable CodeQL checks; verify the guard artifact and run Solidity tests/Slither for the guard in the final integration scope. Resolve confirmed findings before activation.
- Verify preview integration, WalletConnect, actual CSP/cache headers, asset compatibility and restoration of an existing wallet. Bind frontend and broadcaster versions in one release manifest.
- Verify the current on-server image, guard bytecode, fee identity, ETH reserve and both journals before the deployment. Take the required encrypted checkpoint before changing the service. Keep rollback artifacts and the same persistent state.
- Roll out within the existing financial limits and monitor real receipts and fee assurance. An upgrade/rollback must not erase signed requests, reset nonces or reactivate the old saved WETH proof.

**Acceptance:** the exact release manifest has passing compatibility/security evidence, a verified deployment/rollback procedure and working monitoring. Production readiness is established by those results, not by the plan or historical pilot alone.

## Compatibility checks required throughout

| Boundary | Requirement |
| --- | --- |
| Main application and private runtime | Existing entry points, navigation, headers and wallet connection work together on the same release |
| Client and broadcaster SDK | Preserve the tested engine/wallet/shared-models versions unless a separately verified upgrade is needed; keep explicit peer resolutions and the same PPOI policy |
| Dependency security | Carry #1623/#1624 patches, pnpm policy and gates into both standalone projects; #1626's CLI packaging remains compatible with its own release pipeline |
| Browser persistence | Existing encrypted wallets, balances, pending swaps, saved withdrawals and account indices survive update, reload and rollback |
| Payment and gas | Integer rounding, fresh rates, full signed gas exposure plus margin, all existing caps, and authenticated receipt/fee accounting |
| Transport and chain | Canonical Ethereum contracts/delegate, exact guard, trusted read node and private write route; no accidental cross-chain activation |
| Operations | Existing custody, treasury separation, backup key location, manual unlock and journals remain valid |

Before merging another security/dependency PR during this work, compare its changes with this matrix and rerun the affected boundary checks. A green main-app/client job does not substitute for the independent broadcaster job.

## Scope and financial constraints

- Keep the approved 15% minimum margin, 0.5 gwei gas-price cap, 0.0015 ETH transaction/day ceilings and 0.0015 ETH reserve as the starting release limits. A larger budget is a separate financial change.
- Retain the selected RAILGUN fee UX: the user pays from private funds within successful execution, while the operator advances native gas. No new separate customer fee-deposit product is part of this plan.
- Rejected attempts should not create a chain transaction. An included outer revert or an explicit paid cancellation can still consume operator gas without delivering the private fee. Record that residual exposure honestly; this plan does not make unconditional user-funded reimbursement possible. If zero operator loss becomes an absolute release requirement, the payment architecture must be revisited before public activation.
- Added networks, asynchronous private CoW settlement, new paid infrastructure, automatic treasury access and unrelated frontend dependency migrations are outside this Ethereum release.

Stages 1–3 now have reproducible builds and local compatibility/security evidence; see [validation and review closure](../../../apps/broadcaster/VALIDATION.md). The next implementation slice is stage 4: the existing Ophis user flow, including first-use synchronization, while preserving the live pilot's state and financial limits.
