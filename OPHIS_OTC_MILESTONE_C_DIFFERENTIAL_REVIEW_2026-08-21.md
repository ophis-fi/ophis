# Ophis OTC Milestone C — Differential Security Review

**Date:** 2026-08-21; revalidated 2026-08-23

**Baseline:** `0fa6948a` (`origin/main`)

**Review target:** 27 functional slices on `feat/otc-erc20-milestone-c` through `3ae7a1ba`
**Recommendation:** **Conditional approval for local-fork Milestone C development only. Production writes and deployment remain unauthorized.**

## Executive summary

This diff enables the already-reviewed Milestone B read surface by default and introduces a separate, local-mainnet-fork-only ERC-20 transaction module. Exactly three Swapboard v1 selectors are reachable: `createOrder`, `fillOrder`, and `cancelOrder`. Native-ETH wrappers and empty-calldata value transfers remain absent.

The highest-risk path is deliberately narrow:

`curated form/direct order read → OTC_ESCROW token policy → exact request builder → pinned code/WETH/order preflight → exact eth_call simulation → guarded wallet sink → confirmed receipt`

No unresolved product-security finding was identified in the locally validated diff. The eleven formal review findings and seven later blocking review findings were fixed. The implementation is not ready for merge or production exposure: exact-final-head fork evidence, enforceable required-check configuration, and final exact-head Codex review are still open. EIP-5792 is explicitly deferred and disabled for this non-batched ERC-20 release.

## Key metrics

- Diff at the code-review head: 69 files, 4,931 insertions, 104 deletions against `origin/main`.
- Commit structure: 27 functional slices and two evidence commits; largest slice 390 changed lines.
- Deterministic tests: 23/23 scoped Jest suites, 181 passed, one explicitly optional fork case skipped; token policy 26/26.
- Finding distribution: 0 critical, 2 high fixed, 6 medium fixed, 3 low fixed, 0 unresolved product findings.
- Post-review regression run: 197/197 frontend Jest suites, 1,501 passed, one intentionally skipped; focused review-fix matrix 50/50.

## Scope and history

The review covered every implementation file in the committed stack, including:

- `src/ophis/otcWrite/` and its unit tests;
- selector, verified-read, boundary, page, route, and feature-flag changes;
- the Foundry and Cypress fork suites and their test-wallet bridge;
- frontend/fork CI plus the current-head Codex evidence gate;
- the kickoff plan and subtree divergence record.

Relevant history was traced through `103882c0` (A+B merge), the five pre-merge OTC hardening rounds, post-merge fixes through `f55dbb27`, and the current protected baseline `0fa6948a`. `git log -S` confirms the read flag and `readOtcSnapshot` originated in A+B, while `OTC_ESCROW` was introduced as an isolated policy profile before these write sinks.

## Risk-ranked change map

| Area                             |     Risk | Review result                                                                                                                                                                                                                                                |
| -------------------------------- | -------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Request builders and wallet sink | Critical | One dispatch function reaches one submit function. Every builder revalidates policy/amounts/account; the final sink reconstructs the canonical reviewed intent; requests enforce three selectors and zero value.                                             |
| Preflight and transport adapters |     High | Same transport performs reads, simulation, send, and receipt tracking. Chain, client, runtime, WETH, active/configured account, final block hash, order terms, request equality, and receipt status fail closed.                                             |
| Allowance lifecycle              |     High | Only zero may approve and only the exact reviewed allowance may execute. Any positive mismatch exposes zero-only revocation; recovery survives a raced order becoming inactive and a page reload.                                                            |
| Runtime authorization            |     High | Read flag, separate write flag, local-host classification, explicit `fork` build mode, chain 1, and local-client identity are conjunctive. Production defaults write false and does not set fork mode.                                                       |
| Detail/action UI                 |   Medium | Positive, distinct legs and a fresh direct read gate active actions. Cancellation is maker-only; fills are all-or-nothing. Inactive views can expose only directly verified zero-only recovery.                                                              |
| Fork and merge gates             |   Medium | Seven Foundry invariants and six current browser scenarios. Both fork jobs require a configured secret. The trusted-base Codex parser ties complete changed-file scope and evidence to the PR head; required-check policy is still an explicit release gate. |

## Security invariants

1. **No native value path.** All request types fix `value` to `0n`; the write ABI excludes all four ETH wrappers; selector tests pin the three permitted ERC-20 selectors and reject the remaining deployed writes.
2. **Policy at every sink.** Create approval/create, fill approval/fill, cancel, and both zero-only recovery builders validate the reviewed token legs against `TokenPolicyProfile.OTC_ESCROW`. Unknown, native-sentinel, same-token, nonpositive, inactive, nonmaker, and invalid-deadline inputs fail before submission.
3. **No optimistic settlement authority.** Initial action visibility uses a fresh direct order read. Immediately before submission, the code re-verifies chain/runtime/WETH, compares every order field where applicable, and simulates the exact request at the verified block.
4. **One guarded wallet sink.** `useOtcSubmission` is the only production caller of `submitOtcTransaction`; authorization is checked again inside that function. The adapter reconstructs the reviewed request, binds chain/client/active account, and requires a successful receipt.
5. **Index remains optional and untrusted.** It can hide an action on disagreement or freshness failure but cannot supply transaction terms.
6. **Read and write exposure are independent.** Milestone B defaults on; Milestone C defaults off and cannot be enabled by the remote write flag alone.

## Adversarial scenarios reviewed

| Scenario                                       | Expected outcome                | Evidence                                                                                                                                                                                                                                          |
| ---------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Remote flag turns writes on in production      | No wallet affordance            | Local host and `REACT_APP_OTC_WRITE_MODE=fork` remain required at UI and submit authorization.                                                                                                                                                    |
| Malicious token/order object reaches a builder | Rejected before encoding        | Curated policy, positive/distinct amounts, reviewed pair, active state, and maker checks; mutation-style negative tests.                                                                                                                          |
| RPC serves wrong chain/code/WETH               | No simulation or wallet call    | Pinned chain, code hash, WETH wiring, identifiable block, and block-hash confirmation.                                                                                                                                                            |
| Order is filled/cancelled after rendering      | Fresh preflight fails           | Direct all-field reread; raced-fill scenario reloads the inactive order and retains zero-only recovery.                                                                                                                                           |
| Wallet changes chain/account after rendering   | Send rejected                   | Adapter rechecks chain, local client identity, active RPC account, and configured wallet-client account immediately before send.                                                                                                                  |
| Approval succeeds but execution fails          | Allowance is not hidden         | Exact allowance state plus fail-safe recovery; any positive mismatch can only be revoked to zero.                                                                                                                                                 |
| Native selector or nonzero ETH is introduced   | Boundary/request tests fail     | ABI, selector, import-boundary, zero-value, and exact request assertions.                                                                                                                                                                         |
| PR edits its own Codex workflow/parser         | Evaluator still comes from base | `pull_request_target` loads the protected-base workflow, which checks out the base parser and never executes PR-head code. Current-head evidence is required after every push. Required-check enforcement remains a separate release-policy gate. |

## Findings fixed during this review

- **Medium — merge-gate trust/scope hardening.** `pull_request_target` now loads the workflow definition from the protected base, and the job runs the parser from that same base without checking out PR-head code. Money-path scopes include the exact token-policy paths, scoped frontend CI, the full E2E project, Nx configuration, and the dependency lock. Bootstrap PR #1227 landed this evaluator; ruleset enforcement remains a separate open gate.
- **Medium — browser simulation sender corruption.** The inherited Cypress bridge removed `from` from `eth_call`, causing ERC-20 approval simulation to execute as the zero address. Explicit local-fork calls now preserve the sender and route directly to Anvil; the remote connector path retains its existing behavior.
- **Medium — lifecycle browser coverage.** The create-only test was expanded to maker cancellation, exact-approval fill, competing-fill failure, exact leftover revocation, and durable on-chain/UI assertions.
- **Low — external fork flakiness.** Throttled anonymous public RPC cold starts are not accepted as merge evidence. The browser job requires `OTC_FORK_RPC_URL`, disables Nx result reuse, and uses a fresh Anvil process behind a localhost-only, read-only serial proxy with bounded 429 backoff. The proxy accepts only trusted Infura/Alchemy HTTPS origins and never logs the secret URL. PublicNode may serve unrelated host hydration, but every fork-sensitive fixture, wallet read, rendered term, preflight, send, receipt, and assertion remains on the authenticated Anvil authority.
- **Medium — ineffective required-secret assertion.** The injected-wallet workflow's remaining anonymous public-RPC fallback made its nonempty assertion vacuous. The fallback is removed; both fork jobs now fail closed without `OTC_FORK_RPC_URL`.
- **Medium — false-green skipped fork suite.** A live draft-PR probe showed the Foundry contract skipped six fork cases and passed one static case when its RPC variable was empty, allowing that job to exit successfully. The workflow now rejects an empty secret before Forge starts; probe run `32565727585` confirms both fork jobs fail closed on the missing prerequisite.
- **Low — dynamic announcement semantics.** Failure/recovery callouts now use atomic assertive alerts, while confirmations and allowance refreshes use atomic polite status regions. Unit rendering covers fill/revoke/cancel accessible names and pending state.
- **Low — prohibited new SWR fetch path.** Clean-slice review found the new wallet/fork reads used deprecated SWR. They now use memoized `jotai-tanstack-query` atoms with fail-closed enablement, five-second allowance refetching, and explicit confirmed-transaction refresh.
- **High — allowance and reviewed-intent integrity.** Oversized allowances no longer authorize execution, and the final wallet boundary rebuilds and compares the exact reviewed intent before send.
- **Medium — final-state TOCTOU and consent hardening.** The sink rechecks active wallet accounts and final block identity; a synchronous lock rejects duplicate sends; review consent is keyed to account and exact payload.
- **Medium — durable recovery.** A direct refresh can no longer strand allowance after an external fill. Inactive orders expose only zeroing, never approval or settlement.
- **Medium — transitive gate scope.** Fork/Codex scopes cover re-export indexes and frontend package/project/configuration inputs, and the parser rejects an incomplete changed-file list.
- **Low — bounded edge inputs.** Amounts are capped at `uint256`; error traversal is bounded, cycle-safe, and tolerant of throwing provider getters.
- **Blocking review — uncertain submission recovery.** Broadcast-uncertain records can be cleared only after an explicit acknowledgement that the transaction hash was independently verified as dropped and never mined; clearing is bound to the exact account and action payload.
- **Blocking review — canonical identity and persistence.** Token comparisons use canonical address helpers, the uncertain-transaction store follows the `camelCaseBase:v0` convention, and the OTC entity exposes a public barrel instead of deep imports.
- **Blocking review — bounded and recoverable reads.** The whole preflight has a 30-second deadline that prevents any later wallet call, fork-order query failures expose a retry control, and confirmed actions refetch direct order state before the next action is presented.

## Validation evidence

- Scoped frontend Jest at `3ae7a1ba`: 23 suites, 181 tests passed; one explicit optional fork case skipped without its environment.
- Token policy: 26 tests passed. Production frontend build and frontend TypeScript pass.
- Foundry formatting and isolated-profile build pass. With its RPC variable deliberately absent, the suite exits 1 with one failed setup and zero skipped tests.
- Historical configured-fork evidence: Foundry 7/7 and Cypress 5/5 on earlier reviewed heads. The current six-scenario browser suite adds mismatched-allowance clearing and reload-persistent recovery; exact-final-head configured-secret evidence is still required.
- Frontend and E2E project TypeScript pass; the pre-existing `src/support/e2e.ts:58` fall-through now returns `undefined` explicitly without changing Cypress behavior. E2E source lint is clean.
- Scoped application-security review, repository-configured Gitleaks over the branch history, and 3/3 screen-reader semantic rendering checks pass. `pnpm audit --prod` matches `origin/main`: one low, unpatched `elliptic` advisory and no higher-severity advisory.
- Deterministic Cosmos fill/cancel/recovery fixtures pass fixture-scoped axe WCAG A/AA scans with zero violations. Inspected 1200 × 800 screenshots show no clipping, overflow, label ambiguity, or unreadable warning hierarchy; the live fork spec verifies native controls, accessible names, and live-region semantics against the rendered DOM.
- Codex parser self-test, workflow YAML parsing, and diff whitespace checks pass.
- Draft PR #1228 run `32565727585` proves both explicit missing-secret guards fail closed. `OTC_FORK_RPC_URL` was configured on 2026-08-23; the final feature-head check is the authoritative positive evidence.
- Every functional slice is below 400 changed lines and was validated against its immediate predecessor; TypeScript and nearest tests/lint pass at each boundary.

## Test coverage and blast radius

Unit and boundary tests cover authorization conjunctions, selector/value policy, builder mutations, exact allowance states, order/block/account drift, canonical request equality, duplicate submission, inactive and uncertain-broadcast recovery, bounded preflight, query failure/retry, receipt failure, and hostile provider errors. Foundry covers contract-level create/fill/cancel invariants. Cypress covers the composed wallet lifecycle and accessibility; the repository fork secret is configured and exact-final-head CI remains the release evidence.

The blast radius is limited to the cowswap OTC route, shared curated-token policy, the new fork E2E bridge, and CI scope/config files. Milestone B reads default on. Milestone C writes default off and additionally require localhost, explicit fork mode, chain 1, and an Anvil/Hardhat client; production configuration cannot currently reach the sink.

## Methodology, limitations, and confidence

The review compared every commit and the aggregate diff to protected baseline `0fa6948a`, traced history and call sites, enumerated send/signer/import boundaries, tested negative mutations and race states, and reran build, type, lint, policy, secret, dependency, YAML, and whitespace gates. Historical context includes the A+B merge at `103882c0`, five earlier hardening rounds, and baseline hardening through `f55dbb27`.

Confidence is high in the deterministic code controls and medium in operational readiness. Limitations are the pending configured-secret run at the exact final head, absent independent Codex review at that head, and reliance on local-client self-identification as a test-only trust assumption. This is not a human audit, EIP-5792 review, deployment test, or mainnet authorization.

## Open gates and residual risk

- Configure enforceable required checks for the trusted Codex evaluator, frontend CI, and both fork jobs in ruleset `17378394`; bootstrap PR #1227 is merged.
- Run the final fresh Codex review against the final feature head; this report cannot satisfy that independent gate.
- Require the live final-head fork lifecycle, including its rendered-DOM accessibility assertions, as CI evidence; `OTC_FORK_RPC_URL` is configured.
- Keep EIP-5792 disabled until atomic capability validation plus Safe and malformed-capability E2E exist.
- Production write flags, fork build mode, deployment, or a mainnet transaction require a separate explicit owner decision.

This differential review is a code-review artifact, not a human audit or deployment authorization.
