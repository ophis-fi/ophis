# Ophis OTC Milestone C — Differential Security Review

**Date:** 2026-08-21; revalidated 2026-08-22

**Baseline:** `0fa6948a` (`origin/main`)

**Review target:** 14 functional slices plus release evidence on `feat/otc-erc20-milestone-c` through `44a44f79`
**Recommendation:** **Conditional approval for local-fork Milestone C development only. Production writes and deployment remain unauthorized.**

## Executive summary

This diff enables the already-reviewed Milestone B read surface by default and introduces a separate, local-mainnet-fork-only ERC-20 transaction module. Exactly three Swapboard v1 selectors are reachable: `createOrder`, `fillOrder`, and `cancelOrder`. Native-ETH wrappers and empty-calldata value transfers remain absent.

The highest-risk path is deliberately narrow:

`curated form/direct order read → OTC_ESCROW token policy → exact request builder → pinned code/WETH/order preflight → exact eth_call simulation → guarded wallet sink → confirmed receipt`

No unresolved critical or high-severity product finding was identified. The implementation is not ready for production exposure: the fork-RPC secret, post-bootstrap repository ruleset, and final fresh Codex review are still open. EIP-5792 remains disabled pending atomic-capability and Safe/malformed-capability evidence.

## Scope and history

The review covered every implementation file in the committed stack, including:

- `src/ophis/otcWrite/` and its unit tests;
- selector, verified-read, boundary, page, route, and feature-flag changes;
- the Foundry and Cypress fork suites and their test-wallet bridge;
- frontend/fork CI plus the current-head Codex evidence gate;
- the kickoff plan and subtree divergence record.

Relevant history was traced through `103882c0` (A+B merge), the five pre-merge OTC hardening rounds, post-merge fixes through `f55dbb27`, and the current protected baseline `0fa6948a`. `git log -S` confirms the read flag and `readOtcSnapshot` originated in A+B, while `OTC_ESCROW` was introduced as an isolated policy profile before these write sinks.

## Risk-ranked change map

| Area                             |     Risk | Review result                                                                                                                                                                                                              |
| -------------------------------- | -------: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Request builders and wallet sink | Critical | One dispatch function reaches one submit function. Every builder revalidates policy/amounts/account, contract calls enforce the three-selector allowlist, and every request has `value: 0n`.                               |
| Preflight and transport adapters |     High | Same wallet transport is extended for verified reads, exact simulation, send, and receipt. Chain 1, Anvil/Hardhat identity, runtime hash, WETH wiring, account, order terms, and receipt status fail closed.               |
| Allowance lifecycle              |     High | Exact approvals only. On confirmed approval, the UI re-reads and observes a four-second cooldown. Failed/raced execution preserves recovery state and offers a zero-only revoke.                                           |
| Runtime authorization            |     High | Read flag, separate write flag, local-host classification, explicit `fork` build mode, chain 1, and local-client identity are conjunctive. Production defaults write false and does not set fork mode.                     |
| Detail/action UI                 |   Medium | Actions mount only for a fresh direct read, reviewed token pair, active order, and no index disagreement. Cancellation is maker-only; fills are all-or-nothing with a fresh three-minute deadline.                         |
| Fork and merge gates             |   Medium | Seven Foundry invariants and five browser lifecycle scenarios. Both fork jobs explicitly require a configured fork-RPC secret. The Codex workflow and parser run from the protected base; evidence is tied to the PR head. |

## Security invariants

1. **No native value path.** All request types fix `value` to `0n`; the write ABI excludes all four ETH wrappers; selector tests pin the three permitted ERC-20 selectors and reject the remaining deployed writes.
2. **Policy at every sink.** Create approval/create, fill approval/fill, cancel, and both zero-only recovery builders validate the reviewed token legs against `TokenPolicyProfile.OTC_ESCROW`. Unknown, native-sentinel, same-token, nonpositive, inactive, nonmaker, and invalid-deadline inputs fail before submission.
3. **No optimistic settlement authority.** Initial action visibility uses a fresh direct order read. Immediately before submission, the code re-verifies chain/runtime/WETH, compares every order field where applicable, and simulates the exact request at the verified block.
4. **One guarded wallet sink.** `useOtcSubmission` is the only production caller of `submitOtcTransaction`; authorization is checked again inside that function. Adapter checks bind wallet chain/account and local-client identity before sending, then require a successful receipt.
5. **Index remains optional and untrusted.** It can hide an action on disagreement or freshness failure but cannot supply transaction terms.
6. **Read and write exposure are independent.** Milestone B defaults on; Milestone C defaults off and cannot be enabled by the remote write flag alone.

## Adversarial scenarios reviewed

| Scenario                                               | Expected outcome                    | Evidence                                                                                                                                                                                                                       |
| ------------------------------------------------------ | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Remote flag turns writes on in production              | No wallet affordance                | Local host and `REACT_APP_OTC_WRITE_MODE=fork` remain required at UI and submit authorization.                                                                                                                                 |
| Malicious token/order object reaches a builder         | Rejected before encoding            | Curated policy, positive/distinct amounts, reviewed pair, active state, and maker checks; mutation-style negative tests.                                                                                                       |
| RPC serves wrong chain/code/WETH                       | No simulation or wallet call        | Pinned chain, code hash, WETH wiring, identifiable block, and block-hash confirmation.                                                                                                                                         |
| Order is filled/cancelled after rendering              | Fresh preflight fails               | Direct all-field reread; browser raced-fill case proves failure and exact allowance revocation.                                                                                                                                |
| Wallet changes chain/account after rendering           | Send rejected                       | Adapter rechecks chain, local client identity, and exact account immediately before send.                                                                                                                                      |
| Approval succeeds but execution fails                  | Allowance is not hidden             | Polling/cooldown plus fail-safe recovery state; zero-only revoke builder.                                                                                                                                                      |
| Native selector or nonzero ETH is introduced           | Boundary/request tests fail         | ABI, selector, import-boundary, zero-value, and exact request assertions.                                                                                                                                                      |
| PR edits its own Codex workflow/parser to self-approve | Gate implementation comes from base | `pull_request_target` loads the protected-base workflow, which checks out the base parser and never executes PR-head code. Current-head evidence is required after every push; the initial landing is the bootstrap exception. |

## Findings fixed during this review

- **High — merge-gate trust/scope hardening.** `pull_request_target` now loads the workflow definition from the protected base, and the job runs the parser from that same base without checking out PR-head code. Money-path scopes include the exact token-policy paths, scoped frontend CI, the full E2E project, Nx configuration, and the dependency lock. After bootstrap, a PR cannot approve itself by weakening its own workflow, parser, or test target.
- **Medium — browser simulation sender corruption.** The inherited Cypress bridge removed `from` from `eth_call`, causing ERC-20 approval simulation to execute as the zero address. Explicit local-fork calls now preserve the sender and route directly to Anvil; the remote connector path retains its existing behavior.
- **Medium — lifecycle browser coverage.** The create-only test was expanded to maker cancellation, exact-approval fill, competing-fill failure, exact leftover revocation, and durable on-chain/UI assertions.
- **Low — external fork flakiness.** Throttled public RPC cold starts are not accepted as merge evidence. The browser job requires `OTC_FORK_RPC_URL`, disables Nx result reuse, and uses a fresh Anvil process with local rate limiting disabled.
- **Medium — ineffective required-secret assertion.** The injected-wallet workflow's remaining anonymous public-RPC fallback made its nonempty assertion vacuous. The fallback is removed; both fork jobs now fail closed without `OTC_FORK_RPC_URL`.
- **Medium — false-green skipped fork suite.** A live draft-PR probe showed the Foundry contract skipped six fork cases and passed one static case when its RPC variable was empty, allowing that job to exit successfully. The workflow now rejects an empty secret before Forge starts; probe run `32565727585` confirms both fork jobs fail closed on the missing prerequisite.
- **Low — dynamic announcement semantics.** Failure/recovery callouts now use atomic assertive alerts, while confirmations and allowance refreshes use atomic polite status regions. Unit rendering covers fill/revoke/cancel accessible names and pending state.
- **Low — prohibited new SWR fetch path.** Clean-slice review found the new wallet/fork reads used deprecated SWR. They now use memoized `jotai-tanstack-query` atoms with fail-closed enablement, five-second allowance refetching, and explicit confirmed-transaction refresh.

## Validation evidence

- Scoped frontend Jest: 23 suites, 165 tests passed; one explicit optional fork case skipped without its environment.
- Token policy: 25 tests passed.
- Foundry latest-state Ethereum fork: 7/7 invariants passed.
- Cypress Chrome on chain-1 Anvil: 5/5 passed — create, cancel, fill, raced-fill/revoke, mobile keyboard/overflow.
- Frontend and E2E project TypeScript pass; the pre-existing `src/support/e2e.ts:58` fall-through now returns `undefined` explicitly without changing Cypress behavior. E2E source lint is clean.
- Scoped application-security review, changed-scope Gitleaks, and 3/3 screen-reader semantic rendering checks pass. `OPHIS_OTC_MILESTONE_C_APPSEC_REVIEW_2026-08-21.md` records the inherited dependency advisory and remaining external gates.
- Deterministic Cosmos fill/cancel/recovery fixtures pass fixture-scoped axe WCAG A/AA scans with zero violations. Inspected 1200 × 800 screenshots show no clipping, overflow, label ambiguity, or unreadable warning hierarchy; the live fork spec retains Chromium accessibility-tree assertions.
- Codex parser self-test, workflow YAML parsing, and diff whitespace checks pass.
- Draft PR #1228 run `32565727585` confirms no usable `OTC_FORK_RPC_URL` reaches either fork job and proves both explicit missing-secret guards fail closed.
- Every functional slice is below 400 changed lines and was validated cleanly against its immediate predecessor; TypeScript and its nearest tests/lint pass at each boundary.

## Open gates and residual risk

- Merge bootstrap PR #1227, then mark `OTC Milestone C / fresh Codex review` required in the repository ruleset.
- Run the final fresh Codex review against the actual committed head; this report cannot satisfy that independent gate.
- Configure `OTC_FORK_RPC_URL`, then rerun the live fork lifecycle and its Chromium accessibility-tree assertions as CI evidence.
- Keep EIP-5792 disabled until atomic capability validation plus Safe and malformed-capability E2E exist.
- Production write flags, fork build mode, deployment, or a mainnet transaction require a separate explicit owner decision.

This differential review is a code-review artifact, not a human audit or deployment authorization.
