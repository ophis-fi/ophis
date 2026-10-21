# Local validation — 2026-10-21

Latest follow-up: restricted gateway and exact-route Vite proxy, shared client batching, compatible fork marker, browser-wallet network switching, read-only service preflight and production opt-in entry point. See [RELEASE.md](./RELEASE.md).

Worktree: `/Users/scep/ophis-railgun-local`, branch `feat/railgun-local-20261021`, based on `039a9ea6db0a8787de631114f49ff12e2bb46709`. The release is being prepared as a draft PR for hosted checks. No application merge, wallet deployment or funded mainnet transaction was performed. Baal tracing and its protected transport have been deployed separately. f(x) remains paused. The last merged changes require no `@ophis/sdk` API update or version bump.

| Check | Result |
| --- | --- |
| Standalone frozen install, scripts disabled | Passed |
| TypeScript and production browser build | Passed |
| Standalone CI preparation | Pinned actions and pnpm10.33.2; frozen install,47tests,both typechecks and build passed locally on Node22.23.1 with4096MiB heap; repository deployment-boundary checks passed; hosted run pending |
| Unit and dependency regression tests | 47 passed; 3 fork tests intentionally skipped in this command |
| Explicit Anvil fork suite | 3 passed: successful pool call, failed swap pays no Ophis fee, nonce cancellation prevents replay |
| Production browser wallet | Passed: creation, phrase normalization, lock, incorrect password, reload persistence, tab exclusion and retry |
| Full browser roundtrip | Passed: shield, actual Railgun proof, USDC→WETH→USDC private swaps, withdrawal, old-account recovery |
| Full roundtrip through local production gateway | Passed: actual proofs and exact execution simulations through the Wrangler gateway; Anvil-only unlocked signing uses the test sponsor |
| Actual MetaMask 13.53 browser wallet | Connection, reload, approval rejection, wrong-network spending block and Switch to Ethereum passed; transaction sending remains unverified |
| Waku fee discovery | Fresh signed USDC/WETH advertisements found, including the configured 7702 delegate (latest read-only probe: 1 USDC, 1 WETH, 2 canonical advertisements) |
| Baal and protected transport | Private HTTP tracing enabled with execution-only recreation; node synced; consensus/validator untouched. Real delegated calls and traces passed through authenticated HTTPS and the actual Workerd gateway; origin authentication, method/path/body restrictions passed |
| Existing Ophis frontend | Production build and targeted footer lint passed; opt-in HTTPS link verified; clean default output has no local/test URL |
| Browser bundle inspection | No test fixture modules included; patched engine implementation included |

The full roundtrip used the existing Ethereum contracts on an Anvil fork pinned to block 26239582. The guarded test fixture bounds the public indexer to that block, substitutes fork-local PPOI eligibility, and uses an Anvil gas sponsor. Actual proof generation and contract execution are exercised; live PPOI eligibility, timing, and broadcaster transaction acceptance are not established. The basic production-build browser check uses a disposable browser context. The complete roundtrip uses a dedicated generated test profile, never a normal browser profile.

Successful transaction hashes below belong only to the local fork, from the complete gateway-backed roundtrip:

| Step | Local hash |
| --- | --- |
| USDC→WETH | `0x0880c22ec7827756e342eb8bc7c77c06e206899d1c791cc2de75cf2d90628ca8` |
| WETH→USDC | `0x5298e17ab12edfafd1f3e31d5a16c526579432d0f0fc7b454bc89a68916a8805` |
| Withdrawal | `0x3b05a14907a868d9345c420afdf5a59e6db02534b7dac201540ce4e524c1cf47` |
| Old-account recovery | `0xa93d033922c5b6bf42fb97fa35698a1bbfa9ede3b784704213464df3f6f9b93b` |

The gateway regressions additionally check actual ethers batching (45 reads), budgets per call, bounded logs/gas/fee history, unchanged trace calldata and authorizations, redirects, headers and disabled defaults. Fork-marker checks cover missing or different markers and fork resets. One full-browser run encountered a public indexer HTTP 502 after a successful swap; bounded fixture retries and clean route aborts were added, then the complete bidirectional roundtrip passed again.

The first gateway roundtrip correctly rejected the fixture's redundant `evm_mine` call after the swap had executed. The fixture now relies on the runner's existing interval mining. The encrypted journal preserved the uncertain outcome, and the next run reconciled the hashless transaction from wallet history before completing the entire flow. The actual recovery UI's cancel action was also exercised on an earlier uncertain transaction; it cleared the record only after verifying the authorization nonce had advanced. Neither path deleted the journal to bypass its lock.

The final withdrawal regression additionally verifies that spending an input without the expected withdrawal output cannot be reported as a confirmed withdrawal. The encrypted journal remains available for reconciliation.

## Review scope

Ponytail and ethskills guided implementation. Independent Codex and read-only Claude reviews identified issues that were fixed and covered by focused checks: history reconciliation, replacement transactions, journaling before signature disclosure, stale recovery UI, public-wallet network validation, exact execution simulation, cancellation, and withdrawal outcomes. Independent Codex review accepted the change for continued local testing. Trail of Bits insecure-defaults guidance was applied; no comprehensive Trail of Bits audit is claimed.

The subsequent release review found and fixed two medium issues: cached SDK wallet loading could bypass password authentication after a failed opening, and cancellation could clear a record using unconfirmed nonce advancement. Both fixes were independently reviewed and have regressions. The release also upgrades the previously missed bundled bn.js4.11.6, adds actual-consumer and RFC6979 backport regressions, and prevents late development optimizer changes from splitting the SDK singleton. The final build, 47-test suite, explicit fork suite and fresh-server gateway roundtrip passed. A public-rule Semgrep OSS scan ran 180 applicable rules on 30 production files with no findings/errors, excluding one parser-incompatible upstream rule. See [SECURITY_REVIEW.md](./SECURITY_REVIEW.md) for requested-method applicability and the remaining release decision.

Jev evaluated the original eight source claims with probabilities from 0.63 to 0.93, then five release-preparation claims from 0.50 to 0.96. The unchanged trace payload claim scored 0.50 and has a concrete payload-preservation regression; no score was treated as certification. These are review signals, not security certification or an all-green verdict. No new Solidity was written; no Pashov or Verity smart-contract audit is claimed.

## Remaining release constraints

- Baal is synced and supports both delegated calls and tracing. Its HTTP endpoint now exposes bounded tracing only through private access; WebSocket APIs are unchanged. The private HTTP configuration is now applied with an execution-only recreation, and authenticated HTTPS transport plus actual Workerd tracing passed. Consensus and validator were not restarted. Live PPOI service status and compatible signed Waku fee discovery passed; actual PPOI eligibility and broadcaster transaction acceptance need separate validation. No funded mainnet transaction was sent, and fork mode blocks mainnet broadcaster submission.
- The dependency audit retains advisories, including patched versions and legacy Node-only branches. See [DEPENDENCIES.md](./DEPENDENCIES.md). The dependency tree is not approved for production.
- Simulation discloses the signed executable batch to the trusted RPC. Public DEX amounts remain visible. Lost journals cannot reveal offchain signatures held elsewhere; nonce checks do not provide cross-device coordination.
- The complete private roundtrip uses an EIP-1193 Anvil shim. Official MetaMask 13.53 was separately exercised in disposable profiles for connection, reload/reconnection, approval rejection, a switch to Optimism blocking spending, and the application's Switch to Ethereum button. Its confirmation UI reported insufficient funds despite the local RPC reporting a funded balance. A new unique recovery phrase and clean profile reproduced that mismatch: actual injected RPC returned 10 test ETH while approval confirmation stayed disabled. No actual MetaMask approval or shield submission passed; this release gate remains open. Mobile wallets and remote deployment were not tested. Production hosting was exercised only with the local Wrangler runtime.

Machine-local logs, review output, Jev results, bundle module inventory, and the dedicated test profile are in `/Users/scep/ophis-railgun-evidence`; they are not application inputs or repository files.

## Release infrastructure follow-up

The Baal tracing and protected transport gates are closed. The actual local Workerd gateway forwards to the authenticated HTTPS origin with a server-only bearer token; it rejects a missing production token and replaces client Authorization. Mainnet browser build, 47 unit tests, both TypeScript projects, Wrangler deploy dry run and repository deployment-boundary checks passed after these changes. The new manual main-only deployment workflow uses protected Production credentials, an exact Wrangler version, fork-scoped unit tests and an Ethereum production build. It has not been dispatched. The existing frontend workflow accepts the optional footer URL variable; that variable remains unset.

Jev reviewed four narrow deployment claims with probabilities 0.69–0.95. These are review signals, not certification. An independent Codex deployment review found no new concrete issue. Origin auth was tested separately from Cloudflare's browser-integrity edge rejection. See [deploy/README.md](./deploy/README.md) for operations and limits.
