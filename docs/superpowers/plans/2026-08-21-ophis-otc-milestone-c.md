# Ophis OTC — Milestone C kickoff checklist

**Status:** Started on 2026-08-21. Milestone B read-only is enabled. Milestone C writes remain local-mainnet-fork only; no production write deployment or mainnet transaction is authorized.

**Baseline:** Milestones A+B landed in `103882c0`, were hardened through `f55dbb27`, and Milestone C was rebased onto protected `main` at `0fa6948a`. Contract authority remains Ethereum `0x000000fF3D7A2d373615141d7489Ca66683DbecF`, runtime hash `0x8d9ad2a9d3b3d47aaa832ecc21de8775509764409ab07cdf097640396d10eda1`, canonical WETH `0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2`, and pinned upstream commit `7042b1b82defec0eecc4fce668df0fa815e8cc47`.

## Seven-step kickoff gate

- [x] **1. Re-establish the immutable baseline.** Read the A+B implementation plan and integration/indexing specs; compare the pinned upstream implementation with the newer, incompatible zFi Swapboard; keep v1 tuple order and all seven deployed selectors independently pinned.
- [x] **2. Enable B without authorizing C.** Default `isOtcEnabled` to true for the reviewed read-only route. Add `isOtcWriteEnabled` as a separate false default and additionally require a local build with `REACT_APP_OTC_WRITE_MODE=fork`. Production cannot satisfy that build boundary.
- [x] **3. Flip only the ERC-20 selector allowlist and bind policy at every sink.** Enable exactly `createOrder`, `fillOrder`, and `cancelOrder`; leave all four native-ETH selectors disabled. Every exact approval and contract-call builder validates both legs against `OTC_ESCROW`, rejects native/unknown assets, uses zero `value`, and has mutation-style negative tests.
- [x] **4. Make preflight and submission fail closed.** Use exact approvals, bounded positive amounts, distinct tokens, active-order checks, maker-only cancellation, and a short future fill deadline. Immediately before the only wallet sink: verify chain/code/WETH and active account, re-read claimed terms, confirm final block identity, simulate exact calldata, reconstruct the reviewed request, and require a successful receipt.
- [x] **5. Establish the fork suite.** Add an isolated Foundry profile and bytecode-pinned latest-state Ethereum suite covering runtime/WETH identity, exact-approval create/fill, cancel/refund, expired deadline, competing fills, fill/cancel race, and missing approval. CI requires `OTC_FORK_RPC_URL`; the workflow and suite fail with zero skips when it is absent. The suite is complete, while an exact-head configured-secret rerun remains a Step 7 release gate.
- [ ] **6. Require a fresh Codex gate for every merge slice.** Bootstrap PR #1227 head `728f9bf5` contains the trusted-base, mutation-tested parser: money-path PRs require evidence for the current head, and incomplete changed-file scope fails closed. The latest Codex attempt is blocked by review quota. After a clean exact-head review and merge, `OTC Milestone C / fresh Codex review` must be marked required in ruleset `17378394`.
- [ ] **7. Finish C before exposing a production wallet affordance.** The local-fork-only implementation is underway; production writes stay off until every remaining sub-gate and explicit owner approval are recorded.
  - [x] Create/fill/cancel UI uses a single primary action with independent confirmation-bound pending states.
  - [x] Allowance reads refresh after confirmation, lock through a four-second cache cooldown, and expose safe exact-allowance revocation after a failed or raced execution.
  - [x] Error translation covers user rejection, simulation/revert, wrong chain/account, source mismatch, expiry, inactive/raced orders, receipt failure, and transport failure.
  - [ ] Run exact-head configured fork evidence for all seven contract invariants and the six browser scenarios: create, cancel, fill, mismatched-allowance clearing, raced-fill/reload/revoke, and keyboard/overflow. The current code is ready, but `OTC_FORK_RPC_URL` is not available to the jobs. Historical evidence is 7/7 Foundry and 5/5 Cypress on earlier reviewed heads.
  - [ ] Enable EIP-5792 only after wallet capability validation proves approval and escrow execute atomically; add Safe and malformed-capability E2E first. This is intentionally deferred and non-blocking for the current non-batched ERC-20 release; the adapter does not batch.
  - [x] Verify keyboard focus and absence of horizontal overflow for the create form at a 390 px browser viewport.
  - [x] Complete screen-reader and visual verification for fill/cancel/recovery states. Screen-reader semantics pass 3/3 unit-rendering checks; deterministic Cosmos fixtures pass fixture-scoped axe WCAG A/AA scans with zero violations, and inspected screenshots preserve clear fill, cancel-pending, and recovery hierarchy without clipping or overflow. The fork E2E retains live Chromium accessibility-tree assertions for the configured-secret run.
  - [x] Complete and persist the differential security review through code head `3ae7a1ba`.
  - [x] Complete and persist the scoped application-security review through code head `3ae7a1ba`.
  - [ ] Complete the final fresh-Codex review gate against the final committed head.

## Merge slicing

The implementation is committed as 27 functional slices plus three evidence commits, each below 400 changed lines and validated against its immediate predecessor. Later slices close exact-allowance, canonical-intent, active-account, block-identity, duplicate-submit, inactive-recovery, transitive-scope, uint256, and hostile-provider-error findings. Bootstrap PR #1227 is separate and must land first. No deploy follows automatically.

## Kickoff evidence

- Historical configured-fork evidence: seven of seven Foundry cases and five of five earlier Cypress scenarios passed on reviewed precursor heads. The exact current head adds a sixth browser scenario and stronger durable recovery, so it requires a fresh configured-secret run before merge.
- Current deterministic evidence at `3ae7a1ba`: production frontend build and typecheck pass; scoped Jest passes 23/23 suites with 181 tests passed and one explicitly optional fork test skipped; token policy passes 26/26; E2E TypeScript/lint, Foundry format/build, workflow YAML, diff whitespace, trusted parser self-tests, and repository-configured Gitleaks pass.
- Runtime authorization remains conjunctive: read flag, separate write flag, local host, explicit `fork` mode, chain id 1, Anvil/Hardhat client identity, pinned bytecode/WETH, same-provider preflight, and a fresh pre-submit order read where applicable.
- Application-security review found no unresolved product-security issue in the Milestone C diff. Two high, six medium, and three low findings were fixed. The dependency audit matches `origin/main`: one low unpatched `elliptic` advisory and no higher-severity advisory.
- Deterministic Cosmos visual fixtures cover fill-ready, cancel-pending, and recovery-required states. Each fixture has zero axe WCAG A/AA violations; screenshots were inspected at a 1200 × 800 browser viewport with no clipping, overflow, label ambiguity, or unreadable warning hierarchy.
- Reproduction: start Anvil with `--fork-url <RPC> --fork-retry-backoff 1000 --retries 10 --chain-id 1`, run the frontend with `REACT_APP_OTC_WRITE_FLAG=true`, `REACT_APP_OTC_WRITE_MODE=fork`, and `REACT_APP_NETWORK_URL_1=http://localhost:8545`, then run the scoped Cypress spec with `CYPRESS_OTC_FORK_RPC_URL=http://127.0.0.1:8545`. CI requires the repository's `OTC_FORK_RPC_URL` secret for the browser job and retains Anvil's provider-aware rate limiter; it does not treat a throttled anonymous public endpoint as merge-gate evidence.
- Draft PR #1228 run `32565727585` confirms the secret is not currently available to either job and that both jobs terminate at their explicit prerequisite guards instead of reporting skipped or fallback evidence.

## Non-negotiable boundary

Milestone B exposure is reversible through its read flag. Milestone C authorization is separate and conjunctive. A selector entry, feature flag, successful simulation, passing test, or security review is never by itself deployment approval.
