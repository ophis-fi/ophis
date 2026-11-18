# Security Review

Date: 2026-07-27

## Outcome

One application vulnerability was confirmed and fixed:

- **Widget Safe SDK message spoofing** — the iframe bridge accepted Safe-shaped messages from arbitrary windows/origins and forwarded them with wildcard target origins. The bridge now authenticates both `MessageEvent.source` and `MessageEvent.origin`, uses exact destination origins, and fails closed when the embedding parent origin cannot be resolved. Seven focused regression tests cover trusted and attacker source/origin combinations.

No credential, private key, provider token, or PEM private-key material was confirmed in tracked files or the inspected history patterns. Potential secret-shaped matches were treated as sensitive during review and were not printed.

## Solidity review

Twelve independent attacker perspectives reviewed all production contracts under `contracts/src/contracts`. Three issue classes converged in the vendored CoW Settlement baseline:

| Status | Area | Result |
|---|---|---|
| Upstream compatibility risk | `GPv2Settlement.computeTradeExecution` | Per-fill fee flooring can make fragmented partially fillable orders collect less than the signed aggregate fee. |
| Upstream known edge | `GPv2Settlement.computeTradeExecution`, `swap` | A fee-bearing zero-denomination order can retain the zero “unfilled” sentinel and be replayed by an authorized solver. |
| Token compatibility risk | `GPv2Settlement.settle` | Nominal accounting does not reconcile fee-on-transfer input balance deltas. |

These paths require an authenticated solver and belong to the pinned vendored CoW implementation. They were not patched locally because changing settlement accounting or UID completion semantics would create fork-specific protocol behavior and deployment incompatibility. Operational controls should reject zero-denomination orders and unsupported token semantics, constrain solver authorization, and track the corresponding upstream fixes/advisories.

Review leads that did not clear the exploitability gates:

- Authenticator initialization is permissionless until its one-shot initializer is consumed; production proxy deployment must initialize atomically.
- The EIP-1967 proxy admin can bypass a manager-level timelock unless the admin is itself governed by the intended timelock.
- Immediate `setManager(address(0))` temporarily disables add/remove paths but remains recoverable by the proxy admin.
- Fee consolidation should approve only reviewed token/venue combinations; non-standard approval behavior can cause availability failures.

## Fuzzing

- Medusa: 540,381 calls, 1,638 branches, corpus 130.
- Coverage: `AllowListGuardian` 100%; `GPv2AllowListAuthentication` 96%.
- 54 assertion surfaces passed and five surfaces fired across three properties.
- All five failures map to intentionally expected **EXPLORATORY** leads (`SP-21`, `SP-23`, `SP-24`).
- **SHOULD-HOLD failures: 0.**

The full campaign report is in `contracts/fizz_data/report.md`.

## Static, dependency, build, and test checks

- Semgrep security/OWASP profiles: 72 raw findings; manual review identified the iframe bridge as the actionable application defect. Remaining items were repository policy suggestions, documented public CORS behavior, intentional embedding behavior, inert nested workflows, or Dockerfile false positives/dev-only files.
- npm advisory scan: one high and one low advisory. The high advisory is `bigint-buffer` through the development-only Coinbase AgentKit → Solana toolchain; the registry reports no patched `bigint-buffer` release. It is not a shipped runtime dependency of `@ophis/agentkit-ophis`, but should be removed when AgentKit stops pulling the vulnerable optional chain.
- RustSec: upgraded `crossbeam-epoch` to 0.9.20, `anyhow` to 1.0.103, and generated-contract lock entries for `rand` to 0.8.6/0.9.3. Both contract lockfiles now have zero vulnerability findings; only unmaintained-package warnings remain. The main backend lock includes the unpatched RSA timing advisory as a stale/unselected entry (`cargo tree` finds no active reverse dependency).
- Foundry build and normal test suite pass.
- Widget bridge regression tests: 7/7 pass.
- Widget TypeScript compilation and production bundle build pass.
- The frontend ESLint runner currently crashes inside `eslint-plugin-import`/Nx project-graph integration before linting source; this is a tooling failure, not a lint result.
- Rust workspace tests reach platform-specific `system-configuration` panics on macOS in nine autopilot winner-selection tests; this should be confirmed in the Linux CI environment.

## Deployment requirements

1. Atomically initialize every authenticator proxy and verify manager/admin/timelock addresses on-chain.
2. Reject zero-denomination orders before solver submission.
3. Maintain an explicit supported-token policy excluding fee-on-transfer/rebasing behavior unless balance-delta accounting is added.
4. Review every fee consolidation venue and calldata encoder before allowlisting.
5. Monitor Safe allowance, CoW presignature, solver membership, oracle freshness, and curator role drift.
