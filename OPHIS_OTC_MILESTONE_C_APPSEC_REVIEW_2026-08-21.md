# Ophis OTC Milestone C — Application Security Review

**Date:** 2026-08-21; revalidated 2026-08-22

**Baseline:** `0fa6948a` (`origin/main`)

**Review target:** committed Milestone C stack through `44a44f79`
**Recommendation:** **Conditional approval for local-mainnet-fork development only. Production writes and deployment remain unauthorized.**

## Result

No unresolved critical or high-severity vulnerability was identified in the Milestone C diff. Two medium-severity CI integrity findings were fixed during this review: the injected-wallet job supplied an anonymous public-RPC fallback, and the Foundry suite treated a missing RPC as skipped tests while still exiting successfully. Both fork jobs now consume only `secrets.OTC_FORK_RPC_URL` and explicitly reject an empty value before starting the test suite.

The application-security review does not satisfy the independent final Codex review, required-check ruleset, or configured fork-RPC secret.

## Scope and threat model

The review covered the new OTC write module, direct-read and token-policy boundaries, create/fill/cancel/recovery UI, wallet adapters, Anvil bridge, Foundry/Cypress workflows, dependency change, and merge-evidence parser.

Assets and trust boundaries:

- user ERC-20 balances and allowances;
- the immutable Ethereum Swapboard v1 address, runtime bytecode, WETH wiring, and active order terms;
- wallet chain/account/provider state, which may drift after rendering;
- remote flags, index data, RPC responses, and browser input, none of which are settlement authority;
- GitHub workflow inputs and review evidence, which must not be self-authorizing.

The primary abuse cases are production flag bypass, malicious token/order substitution, stale or raced settlement, wrong-chain/account submission, selector/value smuggling, residual allowance after failure, RPC equivocation, secret disclosure, and a PR weakening its own merge gate.

## Controls verified

| Control                         | Result                                                                                                                                                                                                                                  |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Access and environment boundary | Write authorization requires the B read flag, separate C write flag, local host, explicit `fork` build mode, chain id 1, and Anvil/Hardhat client identity. Authorization is rechecked inside the only submission sink.                 |
| Contract and calldata integrity | Runtime hash and WETH wiring are pinned. Only the three ERC-20 selectors are enabled. All request types fix `value` to zero; native wrappers remain absent.                                                                             |
| Input and token policy          | Every approval, create, fill, cancel, and zero-only recovery builder validates both token legs against `OTC_ESCROW`, with positive/distinct amount, activity, maker, and deadline checks where applicable.                              |
| Freshness and race handling     | Pre-submit reads compare every order field, simulation uses the exact calldata at the verified block, and block identity is confirmed. Raced execution preserves recovery state and exposes only exact allowance revocation.            |
| Wallet binding                  | The wallet adapter rechecks chain, local-client identity, and exact account immediately before send, then requires a successful confirmed receipt. Reads, simulation, submission, and receipt tracking share the wallet transport.      |
| Injection and XSS               | No `dangerouslySetInnerHTML`, dynamic code evaluation, cookie write, or raw DOM HTML sink exists in the reviewed path. User/RPC error strings render as React text; local diagnostics are suppressed in production.                     |
| Secrets                         | A changed-scope Gitleaks scan passes. The only allowlisted literals are public mainnet token addresses and Foundry's documented disposable Anvil key. Arbitrary configured keys remain scanned.                                         |
| Supply-chain integrity          | GitHub actions are commit-pinned and the lockfile is committed. The new direct `@ethersproject/keccak256@5.7.0` entry reuses an existing locked resolution.                                                                             |
| Merge evidence                  | `pull_request_target` loads the protected-base workflow, which executes the trusted-base parser without checking out PR-head code and requires evidence for the current head. After bootstrap, a money-path PR cannot weaken its judge. |

Authentication, cookies, database queries, server-side CORS, and SSRF endpoints are not introduced by this client-only feature. RPC URLs remain build/CI configuration rather than user-controlled outbound targets.

## Findings

### APPSEC-C-01 — Public RPC fallback bypassed the required-secret assertion

**Severity:** Medium

**Status:** Fixed

The injected-wallet workflow set `OPHIS_FORK_RPC_ETH` to `secrets.OTC_FORK_RPC_URL || <public endpoint>`, then asserted only that the resulting value was nonempty. A missing repository secret therefore produced nondeterministic public-RPC evidence instead of failing closed. The fallback is removed so only the configured secret can supply fork evidence.

### APPSEC-C-02 — Dynamic transaction state lacked explicit announcement roles

**Severity:** Low

**Status:** Fixed

Visible failure, residual-allowance recovery, and confirmation callouts did not themselves guarantee screen-reader announcements. Failure/recovery now use atomic assertive alerts; confirmations and allowance changes use atomic polite status regions. Unit rendering verifies fill/revoke/cancel names, busy state, and announcement roles. Deterministic Cosmos fixtures for fill-ready, cancel-pending, and recovery-required states pass fixture-scoped axe WCAG A/AA scans with zero violations and have inspected screenshots. The fork browser suite retains live Chromium accessibility-tree assertions for configured-secret CI.

### APPSEC-C-03 — New network reads bypassed the required query abstraction

**Severity:** Low

**Status:** Fixed

Clean-slice review found that local-client verification and allowance polling used a new SWR hook despite the frontend's Jotai query requirement. The hook now creates memoized `jotai-tanstack-query` atoms, remains disabled until every authorization/input prerequisite exists, refetches allowance every five seconds, and preserves the explicit post-confirmation refresh used by recovery logic.

### APPSEC-C-04 — Missing fork secret produced a false-green Foundry job

**Severity:** Medium

**Status:** Fixed

The first live CI probe exposed that the Foundry test contract called `vm.skip` when `OPHIS_FORK_RPC_ETH` was empty. Six fork-dependent tests skipped and one static identity test passed, so the job exited successfully without exercising the fork. The workflow now asserts that the secret-derived environment variable is nonempty before invoking Forge. Draft PR #1228 run `32565727585` proves both the Foundry and injected-wallet jobs fail at this explicit guard when the secret is unavailable.

## Dependency and secret evidence

- `pnpm audit --prod` reports zero critical and one high advisory in the existing repository graph: `@trezor/blockchain-link → socks-proxy-agent@6.1.1 → socks@2.7.1 → ip@2.0.1`. The root already overrides `ip` to `^2.0.1`; Milestone C neither introduces nor calls this Trezor proxy path. This inherited repository finding should remain tracked separately.
- The direct keccak dependency adds no new package resolution and is not on the advisory path.
- Changed-scope Gitleaks: zero unresolved findings after classifying the public token addresses and public Anvil development key.

## Verification evidence

- Frontend TypeScript: pass.
- E2E project TypeScript: pass; the pre-existing uncaught-exception callback now has an explicit `undefined` fall-through without changing behavior.
- OTC action screen-reader semantics: 3/3 pass.
- Deterministic fill/cancel/recovery Cosmos fixtures: zero axe WCAG A/AA violations in each; 1200 × 800 screenshots inspected with no clipping, overflow, ambiguous action label, or unreadable warning hierarchy.
- E2E source lint and changed-file formatting: pass.
- Existing Milestone C evidence remains 7/7 Foundry fork invariants and 5/5 injected-wallet lifecycle scenarios.
- A repeat anonymous-public-RPC browser run on 2026-08-21 degraded during transaction waits and was stopped; it is not accepted as new gate evidence. This validates the decision to require `OTC_FORK_RPC_URL` rather than treating public infrastructure as authoritative CI.
- Draft PR #1228 run `32565727585` confirms the repository currently supplies no usable `OTC_FORK_RPC_URL` to either job and that both jobs now fail closed with the same explicit prerequisite error.

## Residual gates

- Configure the real `OTC_FORK_RPC_URL` Actions secret, then rerun the live fork lifecycle and its Chromium accessibility-tree assertions as CI evidence.
- Merge bootstrap PR #1227, then add `OTC Milestone C / fresh Codex review` to the active `protect-main` required checks.
- Commit the final head and obtain fresh independent Codex evidence for that exact head.
- Keep EIP-5792 disabled until atomic capability validation plus Safe and malformed-capability E2E are complete.
- Any production write flag, fork build-mode change, deployment, or mainnet transaction needs a separate owner decision.

This is a scoped application-security review artifact, not a human audit or deployment authorization.
