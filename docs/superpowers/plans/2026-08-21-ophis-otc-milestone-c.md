# Ophis OTC — Milestone C kickoff checklist

**Status:** Started on 2026-08-21. Milestone B read-only is enabled. Milestone C writes remain local-mainnet-fork only; no production write deployment or mainnet transaction is authorized.

**Baseline:** Milestones A+B landed in `103882c0`, were hardened through `f55dbb27`, and Milestone C was rebased onto protected `main` at `0fa6948a`. Contract authority remains Ethereum `0x000000fF3D7A2d373615141d7489Ca66683DbecF`, runtime hash `0x8d9ad2a9d3b3d47aaa832ecc21de8775509764409ab07cdf097640396d10eda1`, canonical WETH `0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2`, and pinned upstream commit `7042b1b82defec0eecc4fce668df0fa815e8cc47`.

## Seven-step kickoff gate

- [x] **1. Re-establish the immutable baseline.** Read the A+B implementation plan and integration/indexing specs; compare the pinned upstream implementation with the newer, incompatible zFi Swapboard; keep v1 tuple order and all seven deployed selectors independently pinned.
- [x] **2. Enable B without authorizing C.** Default `isOtcEnabled` to true for the reviewed read-only route. Add `isOtcWriteEnabled` as a separate false default and additionally require a local build with `REACT_APP_OTC_WRITE_MODE=fork`. Production cannot satisfy that build boundary.
- [x] **3. Flip only the ERC-20 selector allowlist and bind policy at every sink.** Enable exactly `createOrder`, `fillOrder`, and `cancelOrder`; leave all four native-ETH selectors disabled. Every exact approval and contract-call builder validates both legs against `OTC_ESCROW`, rejects native/unknown assets, uses zero `value`, and has mutation-style negative tests.
- [x] **4. Make preflight and submission fail closed.** Use exact approvals, positive amounts, distinct tokens, active-order checks, maker-only cancellation, and a future fill deadline no more than five minutes away. Immediately before the only wallet sink: verify chain/code/WETH, re-read claimed order terms, simulate the exact calldata at the verified block, then track the receipt through confirmation.
- [x] **5. Establish the fork suite.** Add an isolated Foundry profile and a bytecode-pinned latest-state Ethereum suite covering runtime/WETH identity, exact-approval create/fill, cancel/refund, expired deadline, competing fills, fill/cancel race, and missing approval. Using latest avoids an archive-RPC dependency; PR/scheduled CI requires the configured `OTC_FORK_RPC_URL` secret and fails closed without it.
- [ ] **6. Require a fresh Codex gate for every merge slice.** The fail-closed workflow and mutation-tested evidence parser are implemented in bootstrap PR #1227: money-path PRs fail unless Codex evidence covers the current head and no Codex line finding targets it; pushes invalidate earlier evidence. `pull_request_target` loads the workflow from the protected base, and the job checks out the parser from that same base, so no PR-head code executes or judges itself. After #1227 lands, `OTC Milestone C / fresh Codex review` must still be marked required in the repository ruleset.
- [ ] **7. Finish C before exposing a production wallet affordance.** The local-fork-only implementation is underway; production writes stay off until every remaining sub-gate and explicit owner approval are recorded.
  - [x] Create/fill/cancel UI uses a single primary action with independent confirmation-bound pending states.
  - [x] Allowance reads refresh after confirmation, lock through a four-second cache cooldown, and expose safe exact-allowance revocation after a failed or raced execution.
  - [x] Error translation covers user rejection, simulation/revert, wrong chain/account, source mismatch, expiry, inactive/raced orders, receipt failure, and transport failure.
  - [x] Local fork evidence covers all seven contract invariants plus injected-wallet create, cancel, exact-approval fill, raced-fill failure, exact leftover-allowance revocation, and confirmed-receipt browser paths. Both run in the fork workflow.
  - [ ] Enable EIP-5792 only after wallet capability validation proves the approval and escrow call execute atomically; add Safe and malformed-capability E2E first. The current adapter intentionally does not batch.
  - [x] Verify keyboard focus and absence of horizontal overflow for the create form at a 390 px browser viewport.
  - [x] Complete screen-reader and visual verification for fill/cancel/recovery states. Screen-reader semantics pass 3/3 unit-rendering checks; deterministic Cosmos fixtures pass fixture-scoped axe WCAG A/AA scans with zero violations, and inspected screenshots preserve clear fill, cancel-pending, and recovery hierarchy without clipping or overflow. The fork E2E retains live Chromium accessibility-tree assertions for the configured-secret run.
  - [x] Complete and persist the differential security review against the current full working-tree diff.
  - [x] Complete and persist the scoped application-security review against the current full working-tree diff.
  - [ ] Complete the final fresh-Codex review gate against the final committed head.

## Merge slicing

The implementation is committed as 13 dependency-ordered slices, each below 400 changed lines and cleanly validated against its immediate predecessor: authorization, builders, preflight, adapters/forms, action state, submission queries, controller, accessible controls, panels, page wiring, Foundry fork invariants, injected-wallet support, and fork CI. Bootstrap PR #1227 is separate and must land first. No deploy follows automatically.

## Kickoff evidence

- Foundry, latest-state chain-1 fork: seven of seven create/fill/cancel, expiry, competing-fill, race, and missing-approval cases pass.
- Cypress, Chrome against chain-1 Anvil: five of five scenarios pass — exact WETH approval/create; maker cancel with durable inactive state; exact USDC approval/fill with zero residual allowance; adversarial competing fill followed by exact leftover-allowance revocation; and keyboard/narrow-screen bounds. The harness preserves the simulated sender and uses Anvil's unlocked test account only in explicit local-fork mode.
- Runtime authorization remains conjunctive: read flag, separate write flag, local host, explicit `fork` mode, chain id 1, Anvil/Hardhat client identity, pinned bytecode/WETH, same-provider preflight, and a fresh pre-submit order read where applicable.
- Application-security review found no unresolved critical/high issue in the Milestone C diff. Changed-scope secret scanning, frontend/E2E TypeScript, and 3/3 dynamic announcement/accessibility-name checks pass; the repository's inherited `ip@2.0.1` advisory is documented separately from this money path.
- Deterministic Cosmos visual fixtures cover fill-ready, cancel-pending, and recovery-required states. Each fixture has zero axe WCAG A/AA violations; screenshots were inspected at a 1200 × 800 browser viewport with no clipping, overflow, label ambiguity, or unreadable warning hierarchy.
- Reproduction: start Anvil with `--fork-url <RPC> --no-rate-limit --chain-id 1`, run the frontend with `REACT_APP_OTC_WRITE_FLAG=true`, `REACT_APP_OTC_WRITE_MODE=fork`, and `REACT_APP_NETWORK_URL_1=http://localhost:8545`, then run the scoped Cypress spec with `CYPRESS_OTC_FORK_RPC_URL=http://127.0.0.1:8545`. CI requires the repository's `OTC_FORK_RPC_URL` secret for the browser job; it does not treat a throttled public endpoint as merge-gate evidence.

## Non-negotiable boundary

Milestone B exposure is reversible through its read flag. Milestone C authorization is separate and conjunctive. A selector entry, feature flag, successful simulation, passing test, or security review is never by itself deployment approval.
