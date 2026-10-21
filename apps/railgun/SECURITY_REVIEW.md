# Release security review — 2026-10-21

**Decision: hold merge and deployment.** The user authorized them only when the applicable release checks are green. Code review fixes have passed focused checks, but actual funded PPOI/broadcaster transaction acceptance and hosted checks remain release gates. Actual injected-wallet approval and shielding now pass on the marked fork. The protected RPC transport is now deployed and verified separately. No application merge, wallet deployment or funded mainnet transaction was performed. Draft PR [#1594](https://github.com/ophis-fi/ophis/pull/1594) starts hosted checks; it remains unmerged. Baal tracing and its authenticated transport were deployed during the subsequent authorized release work.

## Review scope

The change adds a standalone browser wallet, a restricted Cloudflare RPC gateway, dependency backports and an opt-in Ophis footer link. It adds no Solidity contract, verifier, proxy upgrade or Lean contract. f(x) remains paused.

| Requested method | Work performed | Limit |
| --- | --- | --- |
| Trail of Bits skills | Independent source reviews using context-building and insecure-defaults guidance; public-rule Semgrep scan; dependency and privacy-boundary inspection | Guided AI review, not a Trail of Bits engagement or certification |
| Pashov skills | Inspected installed Solidity-auditor scope and searched this release for Solidity sources: none | No applicable changed contract; no Pashov contract-audit pass claimed. Installed skill version is 3; current upstream version checked as 4.1 |
| ethskills | Wallet flow, chain/fork validation, exact execution, token precision, allowances, recovery and release checks; independent reviewers | Fork execution does not prove mainnet service acceptance |
| Verity | Checked official compiler documentation and release inputs | Verity verifies supported smart-contract inputs; this TypeScript release has no Verity input or compiler-linked proof. No formal verification pass claimed |
| Ponytail and Codex | Minimal fixes, caller inspection, targeted regressions and independent fix review | No guarantee that all defects are absent |

Verity references: [compiler and contract scope](https://github.com/lfglabs-dev/verity), [trust boundaries](https://veritylang.com/trust-model). Pashov reference: [Solidity auditor](https://github.com/pashov/skills/tree/main/solidity-auditor).

## Findings and fixes

1. **Medium — cached wallet could bypass a retry password check.** A correct-password opening could fail after the SDK cached its decrypted wallet. The next opening could use that cache without authenticating a different key. `wallet.ts` now authenticates persisted encrypted data with SDK `getWalletMnemonic` before loading; its result is discarded. The regression models the permissive cache, failed history scan, incorrect retry and successful correct retry. Independent review confirmed closure against the installed SDK implementation.
2. **Medium — cancellation could clear its journal before nonce advancement was confirmed.** When the latest nonce was already advanced, the old path skipped the receipt wait. `cancel.ts` now requires canonical delegation and an advanced nonce at `head - 1` before clearing or ratcheting. Three regressions retain unconfirmed records and permit confirmed advancement; the real fork cancellation/replay test also passed. Independent review confirmed closure.
3. **Dependency — older bn.js was bundled through legacy unit conversion.** The prior inventory summary missed version 4.11.6. An exact compatible override and actual-consumer regression now cover it; the rebuilt graph excludes that version. See [DEPENDENCIES.md](./DEPENDENCIES.md).

A development-only optimizer issue also surfaced after replacing dependencies: late discovery of polyfill shims changed SDK module identities. The existing buffer/global/process shims are now included in initial optimization. A fresh-server complete gateway roundtrip passed without further optimization changes.

## Validation and evidence

- Full unit and dependency regressions, both TypeScript projects and production build: recorded in machine-local `release-unit-tests.log` and `release-build-command.log`.
- Explicit fork suite: three passed, including failed-swap fee behavior and cancellation preventing replay.
- Complete real-proof gateway-backed fork roundtrip passed after the fixes: shield, both swap directions, withdrawal and old-account recovery. Fork-only PPOI and sponsor fixtures remain explicit.
- Production-runtime browser wallet creation, normalization, lock, incorrect password, persistence and tab exclusion passed.
- Semgrep OSS 1.136.0: 180 applicable rules across 30 explicit production files, zero findings/errors. One incompatible upstream Apiiro rule was excluded and the original failing result retained. No Pro interprocedural coverage is claimed.
- Dependency raw counts remain nonzero. Per-advisory browser reachability and patch notes are preserved; no blanket dependency approval is claimed.
- Baal was inspected over SSH. Its real EIP-7702 trace works over IPC, while HTTP/WS omit debug. The private HTTP configuration was subsequently applied by recreating only execution. Synced status and actual delegated HTTP tracing passed; consensus and validator remained untouched.
- `.github/workflows/railgun-ci.yml` adds standalone checks because the app is outside the root workspace. Actions and the app's pnpm10.33.2 are pinned; permissions are read-only, dependency scripts and checkout credential persistence are disabled, and no production secrets or deploy step are included. Independent workflow review, local structural validation and repository deployment-boundary checks passed. Its actual install/test/build commands passed on Node22.23.1 with a4096MiB heap. No GitHub-hosted run has occurred yet.

Evidence lives in `/Users/scep/ophis-railgun-evidence` outside the repository. It contains disposable local test profiles and must not be published wholesale. Test recovery phrases, credentials, environment files, node_modules and built assets are excluded from Git.

## Remaining release gates

1. Actual injected-wallet approval and shielding passed on the marked fork; retain the separate funded mainnet acceptance gate.
2. Protected tracing and trusted transport are verified through the actual Workerd runtime. Retest the deployed wallet gateway after release.
3. A specifically authorized test wallet and spending cap for live shielding, PPOI eligibility, broadcaster acceptance, private output, withdrawal and recovery.
4. Final deployment configuration, required GitHub checks and release review. The main-only manual deployment workflow uses existing protected CI credentials; it has not been dispatched for this app.

This report records applicable checks and their limits. It is not an all-green or formal-verification verdict.

## Authenticated transport review

The server-only bearer token is required for nonlocal forwarding and cannot be overridden by client headers. Caddy restricts authenticated requests to `POST /rpc`, strips credentials before Baal and limits bodies to256KiB. The two-container transport publishes no host port, runs without root and pins image digests; Caddy retains only the capability required by its official executable. Secrets are excluded from Git and browser builds. Independent Codex source review found no concrete new issue and independently passed five gateway tests. Internal origin tests and public HTTPS tests establish authentication separately from the existing Cloudflare browser-integrity policy. Actual Workerd-to-Baal delegated call and trace simulations passed.

Actual MetaMask13.53 approval and shielding passed through its normal injected provider and enabled confirmation UI on the marked fork, with successful receipts and no remaining allowance. This closes the injected-wallet fork gate; live funded acceptance is still pending. The final deployment source/configuration scan ran212applicable rules across38explicit files with0findings/errors. No new concrete deployment vulnerability was identified.
