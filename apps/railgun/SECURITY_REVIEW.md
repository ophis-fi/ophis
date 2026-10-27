# Release security review — 2026-10-27

**Local release candidate; merge remains gated by the current commit's hosted checks.** A funded private WETH→USDC swap through a real broadcaster has now completed, paid the Ophis fee and returned the committed private USDC output. The output subsequently became Spendable after a read-only refresh; the wallet journal cleared. Native ETH deposits and a separate broadcaster withdrawal were confirmed. Public production enablement requires the deployment checks in [RELEASE.md](./RELEASE.md).

## Scope and requested methods

This release adds a separate browser wallet, a restricted Cloudflare RPC gateway, dependency backports and an opt-in Ophis footer link. It adds no Solidity contract, verifier, proxy upgrade or Lean contract. f(x) remains paused.

| Method | Work performed | Limit |
| --- | --- | --- |
| Trail of Bits skills | Context building, differential review, insecure-default inspection, dependency reachability and public-rule Semgrep scanning | Guided review, not a Trail of Bits engagement or certification |
| Pashov skills | Checked Solidity-auditor scope against changed sources | No changed Solidity input; no contract-audit pass claimed |
| ethskills | Chain and fork checks, wallet safety, exact allowances/execution, precision, fee budgets, recovery and release boundaries | A successful route does not establish every wallet, amount or market condition |
| Verity | Checked the contract/compiler scope against release inputs | No supported smart-contract input or compiler-linked proof; no formal-verification claim |
| Ponytail and Codex | Caller inspection, security review, targeted regressions and removal of an unnecessary SDK-error workaround | No guarantee all defects are absent |
| Claude and Jev | Source-only final-diff review and narrow typed claim checks, including ETH target/value, pairing cancellation and immutable fee budgets | Supporting model reviews, not proofs or certification |

References: [Pashov Solidity auditor](https://github.com/pashov/skills/tree/main/solidity-auditor), [Verity compiler](https://github.com/lfglabs-dev/verity), [Verity trust boundaries](https://veritylang.com/trust-model).

## Security findings closed

- Persisted encrypted wallet data is authenticated before reusing SDK-cached decrypted state. A failed opening followed by an incorrect-password retry cannot bypass authentication.
- Cancellation retains its encrypted journal until the canonical delegate's execution nonce is advanced at the two-confirmation block, including previously advanced nonces.
- Fork-test public cache files use direct reads and exclusive creation; the symlink-insertion regression prevents overwriting unrelated files. Hosted CodeQL passed this fix on the prior commit.
- Legacy bn.js resolves to patched versions through actual consumers. Dependency backports cover GraphQL merge keys, peer-record signer binding, legacy Node WebSocket TLS and elliptic nonce conversion. See [DEPENDENCIES.md](./DEPENDENCIES.md).

## Final follow-up review

The follow-up adds native ETH shielding, WalletConnect, bounded broadcaster discovery, receive-POI refresh, fee-budget capping and fee-reserving Max. The review traced their callers in wallet actions, quote preparation and submission. Wallet and public-connection state changes invalidate stale controls. Native ETH checks the canonical Relay Adapt destination and exact payable value. WalletConnect cancellation isolates subsequent pairing storage and rejects late approval.

Fee math preserves token units and the original total budget. Quote retries are bounded and rebuild the complete recipe; fixed partial amounts retain their meaning. Gas estimates, the 3m floor and the SDK margin are not reduced to force affordability. Fresh fee, network-price, signed-execution, committed-output and recovery checks remain. Max headroom is explicitly disclosed because it can increase the committed fee. No automatic transaction retry or application transaction timeout is added.

Claude's final source review found no proven blocking regression. Its missing-context questions were checked against the installed SDK exports, fee-rounding implementation, canonical configuration and existing tests. Jev's narrow answers supported the stated source properties; probabilities were not used as permission or a safety proof.

## Validation

- Frozen scripts-disabled standalone install passed with the pinned lockfile.
- 138 unit/dependency regressions passed; three fork-only cases are intentionally skipped by the normal command. Both TypeScript projects and the Ethereum production build passed.
- The separate explicit fork suite passed three cases. The complete real-proof gateway roundtrip passed shielding, both swap directions, withdrawal and temporary-account recovery, including the capped-fee budget case. Fork-only PPOI and gas sponsorship remain confined to guarded fixtures.
- Production-runtime browser checks covered wallet creation, password failure, persistence, locking, tab exclusion and quote rendering. Actual MetaMask approval/shielding passed on the marked fork through ordinary confirmations. WalletConnect relay pairing and generated-signer Anvil execution passed separately.
- Final Semgrep OSS 1.136.0: 211 rules on 27 production/configuration targets, no scanner errors. Its one generic-one-liners result points to a readable quote-summary template literal, not obfuscation; it was assessed as a false positive. One previously incompatible upstream rule remains excluded with the original evidence retained. No Pro interprocedural coverage is claimed.
- The standalone version audit still reports 2 critical, 17 high, 11 moderate and 2 low findings. Installed SDK Node-only branches, patched versions and browser-reachable code are assessed separately in DEPENDENCIES.md. This is not a clean dependency-audit claim.
- The installed wallet SDK execution/fee files match the integrity-verified official npm archive; no local SDK edit is needed to reproduce the live result.
- The real Ethereum receipt, canonical delegation, DEX transfers, Ophis fee and exact private USDC output were independently checked. Private transaction identifiers, balances and disposable test profiles remain outside the repository.

## Operational limits

PPOI/network refresh can be slow and can retain cached SDK status after a remote failure. Only Spendable funds pass private spending guards. A capped gas price can become stale; submission rejects it below the current base fee plus tip. Inclusion and future broadcaster availability are not guaranteed. The public wallet must retain ETH for deposit gas, even when the deposit amount itself passes its balance check.

The DEX trade and amounts remain public. A trusted simulation RPC receives the signed executable batch. Encrypted journals must survive uncertain outcomes, and recovery/cancellation can create public links. Browser-origin storage does not migrate from localhost to the public domain automatically.

The gateway fails closed without its server credential, replaces client Authorization, rejects administrative methods and bounds request/trace/log work. Baal's delegated reads and HTTP tracing and the authenticated HTTPS transport were verified. The public wallet domain must be verified separately before the Ophis link is enabled.

The first follow-up hosted run passed the wallet tests/build and most repository checks, but a newly updated advisory blocked legacy contract tooling on qs6.16.0. The release pins the compatible6.16.1 patch using Yarn, with a hostile-coercion regression that fails before the update and passes afterward. Frozen install, dependency compatibility and the OSV baseline gate pass without adding an advisory ignore. The final commit requires a fresh hosted run. No public enablement is inferred from local tests. Evidence remains machine-local outside Git and must not be uploaded wholesale.
