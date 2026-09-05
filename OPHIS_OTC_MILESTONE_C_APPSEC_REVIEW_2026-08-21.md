# Ophis OTC Milestone C — Application Security Review

**Date:** 2026-08-21; revalidated 2026-08-23

**Baseline:** `0fa6948a` (`origin/main`)

**Review target:** 27 functional slices through `3ae7a1ba` on `feat/otc-erc20-milestone-c`
**Recommendation:** **Conditional approval for local-mainnet-fork development only. Production writes and deployment remain unauthorized.**

## Result

No unresolved product-security finding was identified in the locally validated Milestone C diff. Eleven formal findings were fixed: two high, six medium, and three low. Seven later blocking review findings were also fixed. They covered uncertain-broadcast recovery, canonical address comparison, persistence naming, query retry, bounded preflight, entity boundaries, and post-confirmation direct-read refresh.

The application-security review does not satisfy the independent final Codex review, required-check ruleset, or exact-final-head fork CI evidence. The fork-RPC repository secret was configured on 2026-08-23.

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

| Control                         | Result                                                                                                                                                                                                                                                |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Access and environment boundary | Write authorization requires the B read flag, separate C write flag, local host, explicit `fork` build mode, chain id 1, and Anvil/Hardhat client identity. Authorization is rechecked inside the only submission sink.                               |
| Contract and calldata integrity | Runtime hash and WETH wiring are pinned. Only the three ERC-20 selectors are enabled. All request types fix `value` to zero; native wrappers remain absent.                                                                                           |
| Input and token policy          | Every approval, create, fill, cancel, and zero-only recovery builder validates both token legs against `OTC_ESCROW`, with positive/distinct amount, activity, maker, and deadline checks where applicable.                                            |
| Freshness and race handling     | Pre-submit reads compare every order field, simulation uses the exact calldata at the verified block, and block identity is confirmed after the final allowance/simulation reads. Raced or externally filled orders retain zero-only recovery.        |
| Wallet binding                  | The adapter rechecks chain, local-client identity, active RPC account, and configured wallet-client account immediately before send. The sink rebuilds the canonical request from the reviewed intent and requires a successful receipt.              |
| Injection and XSS               | No `dangerouslySetInnerHTML`, dynamic code evaluation, cookie write, or raw DOM HTML sink exists in the reviewed path. User/RPC error strings render as React text; local diagnostics are suppressed in production.                                   |
| Secrets                         | The repository-configured Gitleaks scan passes across all branch commits. Its contextual raw-EVM-private-key rule still scans operational configuration while excluding documented fixture/artifact paths.                                            |
| Supply-chain integrity          | GitHub actions are commit-pinned and the lockfile is committed. The new direct `@ethersproject/keccak256@5.7.0` entry reuses an existing locked resolution.                                                                                           |
| Merge evidence                  | `pull_request_target` loads the protected-base workflow, which executes the trusted-base parser without checking out PR-head code and requires evidence for the current head. Ruleset enforcement of that evaluator remains an explicit release gate. |

Authentication, cookies, database queries, server-side CORS, and SSRF endpoints are not introduced by this client-only feature. RPC URLs remain build/CI configuration rather than user-controlled outbound targets.

## Findings

### APPSEC-C-01 — Public RPC fallback bypassed the required-secret assertion

**Severity:** Medium

**Status:** Fixed

The injected-wallet workflow set `OPHIS_FORK_RPC_ETH` to `secrets.OTC_FORK_RPC_URL || <public endpoint>`, then asserted only that the resulting value was nonempty. A missing repository secret therefore produced nondeterministic public-RPC evidence instead of failing closed. The fallback is removed so only the configured secret can supply fork evidence.

### APPSEC-C-02 — Dynamic transaction state lacked explicit announcement roles

**Severity:** Low

**Status:** Fixed

Visible failure, residual-allowance recovery, and confirmation callouts did not themselves guarantee screen-reader announcements. Failure/recovery now use atomic assertive alerts; confirmations and allowance changes use atomic polite status regions. Unit rendering verifies fill/revoke/cancel names, busy state, and announcement roles. Deterministic Cosmos fixtures for fill-ready, cancel-pending, and recovery-required states pass fixture-scoped axe WCAG A/AA scans with zero violations and have inspected screenshots. The fork browser suite verifies native controls, accessible names, live-region roles, `aria-live`, `aria-atomic`, and the absence of hidden or inert ancestors against the rendered DOM.

### APPSEC-C-03 — New network reads bypassed the required query abstraction

**Severity:** Low

**Status:** Fixed

Clean-slice review found that local-client verification and allowance polling used a new SWR hook despite the frontend's Jotai query requirement. The hook now creates memoized `jotai-tanstack-query` atoms, remains disabled until every authorization/input prerequisite exists, refetches allowance every five seconds, and preserves the explicit post-confirmation refresh used by recovery logic.

### APPSEC-C-04 — Missing fork secret produced a false-green Foundry job

**Severity:** Medium

**Status:** Fixed

The first live CI probe exposed that the Foundry test contract called `vm.skip` when `OPHIS_FORK_RPC_ETH` was empty. Six fork-dependent tests skipped and one static identity test passed, so the job exited successfully without exercising the fork. The workflow now asserts that the secret-derived environment variable is nonempty before invoking Forge. Draft PR #1228 run `32565727585` proves both the Foundry and injected-wallet jobs fail at this explicit guard when the secret is unavailable.

### APPSEC-C-05 — Oversized allowances could survive settlement

**Severity:** High — **Status:** Fixed

Only an allowance exactly equal to the reviewed amount can proceed to settlement. Any other positive allowance, whether lower or higher, exposes only zero-only revocation. Approval is allowed only from zero, and the preflight independently rechecks the exact allowance.

### APPSEC-C-06 — Final wallet request was not bound to the reviewed intent

**Severity:** High — **Status:** Fixed

The final adapter boundary now validates the reviewed intent, rebuilds its canonical request, and requires exact equality of kind, chain, account, target, calldata, and value before sending. Mutation tests reject a structurally valid approval whose amount differs from the reviewed intent.

### APPSEC-C-07 — Wallet/provider state could drift after preflight

**Severity:** Medium — **Status:** Fixed

The final send path now rechecks the chain, Anvil/Hardhat identity, active `eth_accounts` account, and configured wallet-client account. Preflight confirms the final block hash after allowance and simulation. Tests cover chain, client, account, and block drift.

### APPSEC-C-08 — Duplicate submission and stale review consent

**Severity:** Medium — **Status:** Fixed

A synchronous submission lock closes the pre-render double-click window. Review consent is keyed to the exact account and payload and is invalidated when either changes. Boundary tests pin the only submission definition and caller.

### APPSEC-C-09 — Inactive refresh could strand an allowance

**Severity:** Medium — **Status:** Fixed

An order filled by a competitor could become inactive during refresh and unmount the recovery controls. The inactive-order view now preserves a zero-only revoke path for the directly verified token/order pair while suppressing approval and execution. The browser scenario reloads the raced order before revocation to prove durable recovery.

### APPSEC-C-10 — Fork and merge gates missed transitive inputs

**Severity:** Medium — **Status:** Fixed

Fork workflow paths now include token/common re-export indexes plus frontend package, project, Nx, and TypeScript configuration. The trusted-base Codex parser covers those inputs and fails closed if GitHub's reported changed-file total differs from the complete fetched list.

### APPSEC-C-11 — Amount and provider-error inputs were unbounded

**Severity:** Low — **Status:** Fixed

The form and builders reject values outside `uint256` and cap decimal input length. Error translation uses bounded, cycle-safe reflection and tolerates throwing getters so a malicious provider error cannot bypass recovery rendering.

### Post-review blocking findings — recovery, identity, and freshness

**Status:** Fixed

- Broadcast-uncertain records can be cleared only after the user explicitly acknowledges that the exact hash was independently verified as dropped and never mined. The removal is bound to the exact account and action payload.
- Token filtering uses the canonical address helpers; uncertain-transaction persistence follows the required `camelCaseBase:v0` convention; OTC entities expose a public barrel instead of deep imports.
- The entire preflight is bounded to 30 seconds, and a late underlying read or simulation cannot reach the wallet sink after timeout.
- Fork-order query errors render a fail-closed retry state instead of an indefinite loading label. Confirmed actions refetch the direct order before exposing another action.

## Dependency and secret evidence

- `pnpm audit --prod` reports zero critical/high/moderate and one low advisory in `elliptic@6.6.1` (`GHSA-848j-6mx2-7j84`), for which the advisory lists no patched version. An audit of `origin/main` returns the identical result, so Milestone C introduces no dependency-audit regression.
- The direct keccak dependency adds no new package resolution and is not on the advisory path.
- Repository-configured Gitleaks over `origin/main..HEAD`: zero findings. A default-ruleset candidate was the public mainnet USDC contract address, not a secret.

## Verification evidence

- Frontend TypeScript: pass.
- E2E project TypeScript: pass; the pre-existing uncaught-exception callback now has an explicit `undefined` fall-through without changing behavior.
- Scoped frontend Jest: 23/23 suites, 181 passed and one explicitly optional environment-dependent fork case skipped.
- Token policy: 26/26 pass.
- OTC action screen-reader semantics: 3/3 pass.
- Deterministic fill/cancel/recovery Cosmos fixtures: zero axe WCAG A/AA violations in each; 1200 × 800 screenshots inspected with no clipping, overflow, ambiguous action label, or unreadable warning hierarchy.
- E2E source lint and changed-file formatting: pass.
- Production frontend build, frontend/E2E TypeScript, E2E source lint, Foundry formatting/build, workflow YAML, diff whitespace, and trusted-base parser self-tests pass at `3ae7a1ba`.
- Historical configured-fork evidence remains 7/7 Foundry invariants and 5/5 earlier injected-wallet lifecycle scenarios. The current browser suite has six scenarios, including mismatched-allowance clearing and reload-persistent recovery; exact-final-head configured-secret evidence remains required.
- A repeat anonymous-public-RPC browser run on 2026-08-21 degraded during transaction waits and was stopped; it is not accepted as new gate evidence. This validates the decision to require `OTC_FORK_RPC_URL` rather than treating public infrastructure as authoritative CI.
- Routine host-application hydration may use PublicNode in fork CI to avoid consuming the authenticated fork provider's throughput. It is not accepted as fork evidence: fixtures, injected-wallet reads, rendered action terms, allowance checks, preflight, sends, receipts, and final state assertions all remain bound to the secret-backed Anvil instance. A localhost-only, read-only proxy serializes authenticated provider calls and applies bounded 429 backoff; it accepts only trusted Infura/Alchemy HTTPS origins and never logs the secret URL.
- Draft PR #1228 proved both jobs fail closed when `OTC_FORK_RPC_URL` is absent. The secret is now configured; the final feature-head run is the authoritative positive evidence.
- Post-review remediation passes 197/197 frontend Jest suites (1,501 tests passed and one intentionally skipped), frontend TypeScript, full frontend lint with no errors, changed-file formatting, and the focused 50-test review-fix matrix.

## Residual gates

- Require the live final-head fork lifecycle, including its rendered-DOM accessibility assertions, as CI evidence; `OTC_FORK_RPC_URL` is configured.
- Configure enforceable required checks for the trusted Codex evaluator, frontend CI, and both fork jobs in active ruleset `17378394`; bootstrap PR #1227 is merged.
- Obtain fresh independent Codex evidence for the final feature head; earlier-head reviews do not satisfy this gate.
- Keep EIP-5792 disabled until atomic capability validation plus Safe and malformed-capability E2E are complete.
- Any production write flag, fork build-mode change, deployment, or mainnet transaction needs a separate owner decision.

This is a scoped application-security review artifact, not a human audit or deployment authorization.
