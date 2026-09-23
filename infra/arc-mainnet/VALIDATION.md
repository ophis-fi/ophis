# Arc local validation — 2026-09-23

No public deployment, merge or bridge transfer was performed. The automatic
settlement checks used a disposable Arc Anvil chain and labelled 1:1 liquidity
fixtures. Existing real Uniswap liquidity was checked separately in [LIQUIDITY.md](LIQUIDITY.md).

## Release package completed locally — September 23

The remaining submitter preparation is now implemented in `release/solver.cjs`.
It creates an Arc-only key through explicit exclusive creation outside the
checkout, derives the public launch identity, and requires an explicit deployer
nonce. Preparation and startup share the same file/owner/identity validation.
Regression checks cover overwrite prevention, unsafe permissions, symlinks,
malformed keys, mismatched addresses and governance signer separation. CI runs
the new check. The full local Safe rehearsal now provisions a fresh disposable
solver through this command's implementation, funds it on Anvil, authorizes it,
settles and revokes it successfully. Render checks bind every driver/autopilot
lane to the same planned solver.

All changed-path checks passed; temporary keys and the owned node were removed.
No production key was created or read, and no public RPC was called. Disk space
was 5.3 GiB. Jev (`jev-1.13.0`, 2,146 input / 62 output tokens) provided a bounded
advisory review of overwrite and identity checks; this is not security proof.
Production key provisioning/backup, funding and the deployment/activation
ceremony remain runtime operations, with runnable instructions in the release
runbook. Existing contract/frontend reviews below still apply; this pass changes
only release tooling and its tests.

The [release package](release/README.md) now includes unsigned deployment plans,
Ledger ceremony/resume tooling, real Safe verification, production configuration,
guarded startup, persistent credit accounting, frontend/explorer activation and
CI checks. Its example uses the existing Safe, owners and deployer. Deployment
history confirms a separate submitter EOA per chain; the stale Robinhood solver
default has been removed. Arc's dedicated submitter is provisioned on the runtime
host during the launch ceremony, rather than choosing an existing chain's key.
Planning rejects an unset solver; offline checks use disposable preview identities.
The example nonce is not a live observation. Nothing was broadcast,
published, merged, or pushed.

Latest verification:

- Four backend binaries built with bounded parallelism. Configs: **98 passed**;
  balance overrides: **18 passed, 2 existing live tests ignored**; event indexing:
  **15 passed, 5 existing network tests ignored**. The new deployment-block
  deserialization checks also passed. Production resumes its stored event cursor.
- Frontend and explorer TypeScript checks and **both production builds with Arc
  enabled** passed. Scoped tests: activation **10**, native/explorer utilities **2**,
  wallet chain gate **2**, bridge/quote **34**, TWAP menu **1**, explorer API **1**.
  Changed frontend files passed ESLint; patch application and all lockfile patch
  hashes were checked. CI includes these tests and a clean frozen dependency install.
- Actual seven-contract production rehearsal passed on a disposable, non-forked
  Anvil with a real Safe: one signer cannot add a solver or upgrade auth; two
  signers authorize; the solver settles; revocation blocks settlement. Creation
  inputs, runtime, domain, relayer, vault, manager, proxy owner, pending manager,
  Safe proxy/singleton bytecode, owner set and threshold were checked.
- Real eRPC tests passed for the pilot and release on an isolated Docker network:
  two-voter state reads, disagreement/missing-voter rejection, no client bypass,
  cache boundaries, weighted credits and no retry amplification. Only the free
  official upstream relays signed transactions. QuickNode never receives them.
- Credit-gate tests: **3 passed**, including concurrent reservations, restarts,
  fixed total allowance, pacing and method rejection. Pilot and release share one
  named SQLite volume. HTTP redirects are disabled. Real Nginx checks confirmed
  quote throttling (`404,404,429,429` against the mock backend) and CORS access for
  both swap and explorer. Linux-only file-permission checks confirmed that the
  runtime must use the private files' owner UID; startup now enforces that.
- Fresh browser corridor passed after the slow-fill status fix: a signed source
  swap/CoWShed deposit, **slow-fill-requested remains pending**, fixture delivery of
  **99.9 USDC**, then an automatically settled **10 USDC → 9.944533 EURC** Arc swap.
  Remaining USDC: **89.9**. Arc transaction:
  `0xa73658369dc70b05479eca933636ea1179074f52986b3842dd21ca7384a54e04`.
  This uses actual Arc backend/contracts with labelled source/liquidity/relayer
  fixtures. It does not prove live Across delivery.

Ethskills/Pashov/Trail-of-Bits-style review found and fixed separate pilot/release
credit ledgers, ineffective Nginx throttling, missing Safe bytecode provenance,
Linux private-file ownership, a duplicate unconfigured explorer API client,
undeployed Arc TWAP exposure, and premature slow-fill completion. The new
nonpayable reverting vault was scanned with Slither's **101 detectors**. These are
tool/AI-assisted reviews, not certifications from the named audit firms. Earlier
core-contract Slither/Pashov findings and limitations remain documented below.

Jev (`jev-1.13.0`) supplied a narrow release/cursor advisory check (538 input,
38 output tokens); it has no runtime authority. A dependency-security check on
the shared old node_modules initially failed an unapplied existing elliptic patch.
An isolated clean dependency installation using the repository's security patches
passed all 13 dependency regression groups; the shared checkout was not modified.
Full remote CI has not run because this work remains local.

This release pass used **zero public RPC calls, zero QuickNode credits and zero
dRPC calls**. Local processes were stopped and disposable solver keys removed.
Disk stayed above the 3 GiB cached-build floor; no fresh Docker Rust build was
attempted. Remaining public-launch work is the operator ceremony, funded accounts,
service/DNS/frontend publication and live swap/bridge smoke tests in the runbook.

## Completion and security verification — September 23

The local integration passed again after the review fix. This is verification of
the local candidate, not a public release or a security certification by an audit
firm. No QuickNode or dRPC calls were used during this review.

### Fixed during review

Arc finalized indexing previously accepted decoded logs without validating their
metadata. The database converter silently drops logs missing a block number,
transaction hash or log index, so the cursor could advance past an event forever.
The deterministic path now rejects missing, removed, out-of-range or
storage-overflowing metadata before appending or advancing. Other chains retain
their existing indexing path. Regression checks cover failed fetches/appends,
failed checkpoint writes, restart/replay and unchanged cursors on invalid logs.
This protects against malformed responses; it does not prove RPC log completeness.

The browser check now requires exactly one finite permit prehook and successful
Permit and Order signatures. It first rejects the permit and fallback approval,
verifies unchanged allowance, dismisses the error and retries. The rebuilt backend
then automatically settles the order and the UI reaches completion. The final
run took **57.07 seconds**, with **111 local backend requests**, including the
rejection/retry flow and background work. Transaction:
`0xdffff7f92bc80ef6d178d1a31b370721ffac80c0c43101c0c8e1a8f7721d2f4d`.

### Bridge execution completed locally

The recorded SDK hook executed through the actual committed Weiroll VM on an
owned, non-forked local chain with source chain ID 8453. Its initcode hash and
canonical CREATE2 address were checked. The source token, CoWShed execution host,
SpokePool and CREATE2 proxy were fixtures; math used the repository's helper.
The test checked every deposit argument, a 100,000,000-atom input and
99,986,979-atom output, token pull and fully consumed approval. Expired deadlines
and a SpokePool revert after transfer both rolled back balances, allowances and
deposit count. The test stopped its own Anvil afterward.

This verifies the bridge leg of a **source swap plus bridge**, such as Base WETH
→ USDC → Arc USDC. The existing frontend does not support a same-token source
swap: the Base USDC → Arc USDC SDK quote is not a direct bridge-only UI test.
That isolated check did not cover a complete cross-chain browser flow. The
complete local browser corridor below now passes. Live Base execution and Arc
delivery remain unverified; the legacy Across API limitation also remains.

### Complete browser corridor — local fixtures, real Arc backend

`node infra/arc-mainnet/local/check_bridge_browser.cjs` passed with one browser
session and the same wallet throughout:

1. Finite approval and signed Base order: 0.05 WETH → 100 USDC through the source
   settlement fixture. The harness verifies the order's EIP-712 signature and
   appData hash before execution.
2. The committed CoWShed factory/implementation and Weiroll VM execute the actual
   signed post-hook. The fixture SpokePool receives 100 USDC and emits the SDK's
   deposit event for 99.9 USDC on Arc. Finite allowances are fully consumed;
   replay reverts with the specific `NonceAlreadyUsed` error.
3. The UI visibly shows bridge `in progress` while the destination wallet has
   zero USDC. A local relayer fixture transfers exactly 99.9 USDC, and the UI
   reaches `Bridging completed!`.
4. The user-facing network selector switches to Arc. The frontend signs a finite
   10 USDC permit and Arc order; the actual Ophis solver/driver automatically
   settles it. Received: **9.944533 EURC**, above the signed minimum. Remaining:
   **89.9 USDC**. The test checks the exact order's Trade event, full filled
   amount, configured solver's settlement transaction, zero remaining allowance,
   indexed `fulfilled` status and completed UI.

Local Arc settlement transaction:
`0x488fc03016192e8711301e7e0462e6c3f454713b052b24aed9bc7b994b1641af`.
Raw result: `local/generated/bridge-browser-result.json`; screenshots:
`bridge-browser-pending.png`, `bridge-browser-received.png`, and
`bridge-browser-arc-swap.png` in the same ignored directory.

This exposed a real switching defect: Arc was absent from the shared wallet
allowlist, and both wallet-state updaters treated it as unsupported and retained
the previous Base URL's chain. The allowlist now uses `ARC_ENABLED_CHAIN_IDS`;
both updaters and the token-reversal guard reuse `isSupportedChainId`. Arc remains
disabled in production. Both enabled/disabled wallet gate tests, frontend
TypeScript, changed-file lint and the standalone bridge rollback regression pass.
An independent Ethskills QA reviewer checked the predicates and strengthened the
pending-state/replay/settlement assertions before the successful run.

Source pricing/settlement, Across HTTP responses, SpokePool and relayer are
fixtures; Arc venue liquidity is also a fixture. This proves the complete local
integration, not public source settlement, live relayer delivery or live pool
execution. Browser traffic is intercepted or blocked, including WebSockets;
**zero QuickNode credits and zero dRPC requests** were used. TypeSafe Jev supplied
an additional advisory scope check (464 input / 40 output tokens), not a security
verdict. Reproduce using the [local runbook](local/README.md#complete-local-browser-corridor).
Owned frontend, source chain and Arc lab services were stopped afterward; the
disposable solver key was removed. Final disk check: **6.3 GiB free**. Changes
remain local and unmerged.

### Verification results

| Check run during this review | Result |
| --- | --- |
| Event indexing, including malformed log and storage failure/restart cases | 15 passed; 5 existing network tests ignored |
| Driver interaction allowlist | 34 passed |
| Direct V3 ABI / optional KyberSwap regressions | 1 / 12 passed; 2 existing live Kyber tests ignored |
| Native USDC balance override and overflow | 1 passed |
| Native/ERC20 price scaling | 1 passed |
| Frontend Arc, bridge/provider and stable-currency regressions | 39 passed |
| Arc utility and explorer regressions | 2 passed |
| Frontend TypeScript check | Passed |
| Rebuilt autopilot plus real backend/browser automatic settlement | Passed |
| Recorded bridge quote/ABI inspection and local VM execution | Passed |
| Existing Across helper/Weiroll Foundry properties | 8 passed, including 1,024 fuzz cases; 1 live fork test explicitly skipped |
| Local signer/configuration and disk guards | Passed |
| Isolated eRPC quorum, cache, weighted budget, retry bounds and denied methods | Passed; Docker network had no internet access |

Ethskills QA/security guidance was applied to this React application. Source
review covered network guards, duplicate-approval protection, production Arc
disablement, recipient validation, USDC units, wrapping exclusions and RPC
configuration. The browser covered connection, rejection recovery, finite permit,
order submission and completion. The additional corridor above exercises
Base→Arc switching through the network selector; mobile deep links and real
wallets were not tested. Scaffold-ETH-specific components and public deployment verification are
not applicable to this local build. The user's RPC budget takes precedence over
the QA guide's generic recommendation for faster polling.

Pashov's installed Solidity auditor skill was used with **three reviewers covering
its twelve lenses**, adapted to the available agent slots. Scope: Trader,
Spardose, GPv2Settlement, GPv2VaultRelayer, GPv2AllowListAuthentication and
AcrossMathHelper, plus relevant Rust/frontend integration paths. No exploitable
Arc-specific Solidity vulnerability was confirmed. This is AI review using the
skill, not an audit performed by Pashov or Trail of Bits.

Trail of Bits' secure-workflow and token-integration checklists were applied.
Slither 0.11.5 ran **101 detectors** on each of four roots: Trader, settlement,
authenticator and AcrossMathHelper, including their dependencies. Pinned solc
0.8.30/0.8.28 runs produced 69 raw warnings (duplicates included): 6 high,
7 medium, 9 low and 47 informational. These are tool severities, not 69 confirmed
vulnerabilities. Inheritance, function-summary and vars-and-auth outputs were
generated and inspected. Triage:

| Warning group | Assessment |
| --- | --- |
| Arbitrary token pulls | Settlement verifies signed orders before deriving transfers; vault relayer is creator-restricted. |
| Trader arbitrary native send | Existing simulation-only helper; never publicly deployed by this work. Arc USDC explicitly bypasses wrapping. |
| Controlled delegatecall / unprotected upgrade | Simulation delegatecall unconditionally reverts, including side effects. The initializer is public until initialized; the isolated lab initializes it immediately. Any future public deployment must initialize atomically. No Arc proxy upgrade was introduced. |
| Divide before multiply | Detector joins mutually exclusive buy/sell branches; existing checked settlement arithmetic and signed limit checks remain intact. |
| Uninitialized memory structs | Every consumed field is assigned before the call. |
| Unused UID extraction values | Callers intentionally use only the owner or expiry needed for their check. |
| Reentrancy / calls in loops | Settlement uses nonReentrant and solver authorization; EIP-1271 validation is external by design. Arc vault swaps fail closed through DisabledVault. |
| Missing zero checks / timestamps | Existing privileged manager semantics, always-reverted simulation target, and intentional order expiry comparisons. |
| Informational output | Assembly/call patterns, naming, pragma/complexity and event indexing notices; no new actionable Arc defect identified. |

The token review covered shared native/ERC20 USDC balances, 18/6 decimals,
checked funding conversion, finite permits, SafeERC20 return handling and
failure rollback. USDC/EURC issuer pauses/blocklists/upgrades remain external
dependencies; the tests do not establish arbitrary-token compatibility.
Manual review also covered signed chain/settlement domains, order replay,
slippage/recipient bindings, privileged solver roles and the absence of secrets
in browser Arc configuration. Local fixture liquidity is not a price oracle.

TypeSafe Jev was used for an advisory evidence/scope check (497 input and 39
output tokens). It does not replace the deterministic tests or reviewer findings.
Reproduce the bridge execution and property campaign with the commands in the
[local runbook](local/README.md). Raw scan, diagram and test artifacts are ignored
under `local/generated/`; no credentials are included in this report.
Owned lab/frontend/bridge services were stopped, the disposable solver key was
removed, and the final disk check showed **6.6 GiB free**. All work remains local
and unmerged.

## Prior validation — September 22

### Automatic settlement

The frontend signed a finite 10 USDC permit and an Arc EIP-712 order. The actual
solver won the auction; the actual driver signed and submitted its settlement.
The browser test did not call settle manually. It checked the signed minimum
EURC output, full filled amount, zero remaining permit allowance, a Trade event
for that exact order from the configured solver, indexed fulfilled status and
the completed UI. Both the three-venue lab and Uniswap-only configuration passed.
The final indexer build also passed the Uniswap-only browser flow. The clean
browser run took 37.7 seconds and recorded 92 backend requests,
including one raw settlement submission and 1 settlement trace. These counts
include UI quote refresh and background polling, so they are a complete test
window, not an isolated per-auction constant. Local transaction:
`0xaecb19ec71cf51b41110021e483138a3b02b8cccad70ead84d9a92a7df511ed7`.

An Ethereum-style five-block submission window expired before the local poll
could observe it. The lab now budgets 120 one-second Anvil blocks. Public Arc
needs its own measured block-cadence/deadline configuration; this is not a public
transaction relay configuration.

## RPC usage

All figures below are **local backend request counts**, not QuickNode bills.
The loopback meter counts individual JSON-RPC batch elements and includes
background work. Browser wallet calls, deployment and test assertions are excluded.

| Configuration / check | Requests |
| --- | ---: |
| Three direct lanes: verified quote | 29 |
| Uniswap-only: verified quote | 13 |
| Old event indexing, 30-second polling: idle over 60 seconds | 128 |
| Arc range indexing, same polling: idle over 60 seconds | 12 |
| Clean browser approval/order/automatic settlement window | 92 |

Quote requests fell 55%; idle requests fell 91%. Slower polling alone had left
128 requests/minute, above the pilot's 120/minute limit per public provider.
The root cause was fetching headers and logs separately for every new block.

Arc's [official indexing guidance](https://docs.arc.io/integrate/infrastructure/indexing-events)
states deterministic finality and supports ranged log queries. Only chain 5042
opts into the new path: at most 100 blocks per range, old and end checkpoint
hash checks, no cursor advancement on failed reads, and bounded retryable catch-up.
Other chains retain the existing reorg-aware algorithm. This continues to trust
RPC responses; the proposed public proxy uses two-provider agreement, not local
consensus validation.

These measurements provide headroom for a small pilot, not a guaranteed traffic
capacity. Public quorum sends protected reads to two upstreams, and provider
polling, startup, catch-up, timeouts and simultaneous users add work. The existing
rate limits still fail closed. Do not point every backend request at QuickNode.
Keep QuickNode restricted to settlement traces under the existing budget and
leave dRPC unused. No paid-plan upgrade or hosted node is needed for this lab.

## Inbound bridge

A live SDK fee quote fetched at **2026-09-22 21:40:04 UTC** returned:
**100 Base USDC → 99.986979 Arc USDC**, before source-chain transaction gas.
This is a recorded quote, not a current price or guaranteed fill.

The unsigned SDK Weiroll hook was built and decoded locally. Checks covered the
source and destination tokens, six-decimal amounts, recipient, fee calculation,
SpokePool approval/deposit target, Arc destination chain, input/output bindings,
quote/fill/exclusivity parameters and empty message. The source and destination
SpokePools matched [Across's contract table](https://docs.across.to/chains-and-contracts).
The adapter refused all RPC calls; nothing was signed or submitted.

Across labels [suggested-fees as legacy](https://docs.across.to/api-reference/suggested-fees/get).
The existing patched Ophis SDK still quotes this route, but migrating that shared
integration to the Swap API is separate maintenance work. Hook execution on Base
and an actual fill on Arc remain unverified.

## Checks and services used

- Event-indexing Rust tests: 14 passed, 5 existing network tests ignored; covers
  empty ranges, bounded catch-up and checkpoint/log/head failures.
- Autopilot compiled; real local backend and browser checks passed.
- Local signer/configuration guards, disk guard, bridge replay and RPC batch
  accounting checks passed.
- TypeSafe Jev provided two advisory checks (local signing scope and Arc indexing
  assumptions). Execution, RPC accounting and pass/fail assertions stay deterministic.
- This work used **zero QuickNode credits, zero dRPC requests and two Across HTTP
  quote requests**. All RPC execution/testing was local. Earlier read-only network
  checks are accounted for separately in LIQUIDITY.md and README.md.

Reproduce with the [local runbook](local/README.md). Detailed output is kept in
ignored `local/generated/` files; no credentials belong in this report.
