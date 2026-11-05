# RAILGUN dependency gate and acceptance update

Date: 5 November 2026. PR: [#1632](https://github.com/ophis-fi/ophis/pull/1632).
Tested source: `bcde02163f54ff832824ddc3e6fe38577c6c59ca`.
This supplements the [preceding source review](2026-11-05-railgun-final-source-review.md).

## Completed

The Rust dependency blocker is resolved without a new advisory exception or
weaker source/target policy. Compatible maintained dependency releases remove
archived `pin-utils`. Alloy's remaining WASM timer dependency uses a bounded
`wasmtimer 0.4.3` path patch: the manifest and two pin-projection modules change;
upstream clocks and schedulers are preserved. The MIT license, immutable archive
checksum, original file hashes and maintenance instructions are retained in
`apps/backend/vendor/wasmtimer/`. Packaging and CI include that patch and its
standalone lockfile.

Independent Codex review of the 36-file delta from `235541d5` found no actionable
defect. Claude's supplied-source review found no merge-blocking source defect.
These are AI-assisted reviews, not certification by an audit firm. The original
RAILGUN runtime, guard, financial limits and chain-activation gates are unchanged
by this follow-up. The fork-test caller now follows the current wallet setup and
waits for explicit readiness instead of network idleness during continuous RPC.

| Check | Result |
| --- | --- |
| [Backend CI](https://github.com/ophis-fi/ophis/actions/runs/42063493001) | Passed at the tested SHA: whole-workspace/all-target compilation, Ophis-diverged native unit tests, three settlement/partner-fee integration steps and correctness Clippy checks. |
| [Security CI](https://github.com/ophis-fi/ophis/actions/runs/42063499504) | All 25 jobs passed at that SHA, including strict cargo-deny, cargo-audit, all four Rust OSV locks, JS dependency gates, secrets and Slither baseline checks. |
| Timer checks | Four focused pinning/API tests, the negative conditional-Unpin doctest and WASM32 compilation pass on pinned Rust 1.96.1. Archive checksum and all 24 original file hashes independently verified. |
| Combined Ophis shell/private runtime | Production build, mainnet history scan, actual WalletConnect pairing/cancel/retry/disconnect, saved encrypted-wallet reload, header/frame/public navigation and analytics isolation pass. Zero wallet transaction or signature requests. |
| Own-broadcaster proof roundtrip | Two fresh fork wallets, two swaps and four withdrawals pass through six broadcaster signatures/submissions. Six fee notes independently authenticated; underpayment, replay and delegate-race controls pass; no leaked write or unresolved operator journal. |
| Contract/provider compatibility | Four direct real-contract fork tests and two protected-provider fork tests pass. Live read-only registry, delegated type-4 simulation/trace and 500-block log readiness pass on Ethereum, Arbitrum, BNB Chain and Polygon. |
| Running Ethereum guard | Exact guard bytecode/operator binding verified read-only. Existing deployment and funded identity were not changed. |

The two hosted runs were explicitly dispatched against the branch because
GitHub's PR head still reported `235541d5` after a transient push failure. Their
recorded head SHA is the tested `bcde0216`; they are not evidence for a different
PR head. PR-head/check synchronization must be resolved before merge.

Cold synchronization took 338 seconds in the uncached live-history UI run;
reload took two seconds. The two proof-fork wallets took 152/142 seconds cold and
4/3 seconds warm. These measurements do not promise immediate first use.

## Review follow-up

Claude raised a conditional cargo-chef version-masking concern. The upstream
implementation at `dd01a86e7427fe2ceebf0eec13d0c6ad7c21def8` derives manifests from
workspace members and masks only those package names. Locked/offline metadata
confirms the excluded timer is absent from all 42 workspace packages; its
source-less lock entry and separately copied manifest retain version `0.4.3`.
The proposed masking trigger therefore does not apply to this layout. A complete
playground Docker image was not built.

Native AWS/Hyper dependency upgrades are broader than the timer patch. Native CI
passes; live KMS/S3 credentials, retries and uploads were not exercised. Qualify
those paths before deploying a Rust backend that uses them. The timer note's
unchanged-native-behavior statement applies to the timer patch only. The existing
Rust release workflow is manual; no Rust release was dispatched here.

## Remaining release requirements

1. **Protected submission on the three added chains.** Arbitrum's direct
   sequencer/conditional API does not by itself establish rejection of every
   reverting RAILGUN transaction. BNB's raw private RPC does not establish the
   separate bundle route's no-revert semantics. Polygon's official free Private
   Mempool route requires access before the endpoint and its policy can be
   qualified. No vendor was contacted or paid; an access-request draft is ready.
   Existing non-Ethereum mainnet signing gates remain enforced.
2. **Chain commissioning.** Approved operator identities, owner pins, guards,
   native budgets, fee-token valuation, funded protected inclusion, authenticated
   fee receipts and recovery still need acceptance on each added chain. Protocol
   support, read-only compatibility and fork results do not substitute for these.
3. **Final funded/live acceptance.** The proof roundtrip used Anvil, modeled fork
   fee rates and local protected-write fixtures. It did not exercise production
   Flashbots inclusion, PPOI, actual phone/Ledger spending or full live operator
   wallet-history assurance. The six fork fee notes were independently scanned.
   State-preserving deployment/rollback remains a release step.
4. **Respect approved spending limits.** At Ethereum block 26,349,866, base fee
   was 2.474612688 gwei, above the approved 0.5 gwei ceiling. The gas wallet held
   0.003228908919581249 ETH, sufficient for the approved 0.0015 ETH reserve plus
   one 0.0015 ETH maximum. No cap was raised and no mainnet gas was spent.

The user fee covers validated maximum gas plus the configured margin on a
successful transaction. An included revert, provider failure or paid cancellation
can still spend operator gas without receiving that fee. The present design
cannot guarantee zero operator loss; audits and fork tests do not change that.

**This update clears the Rust gate and the specified fork/read-only/browser
acceptance. It does not clear all four chains for mainnet release or authorize
merge/deployment.** Base remains outside scope pending the owner's go-ahead.

Raw manifests, CI snapshots, reviewer outputs and results are retained in the
private evidence directory `ophis-railgun-evidence/unblock-20261105`. It contains
no real wallet recovery material. This report adds no executable source changes.
