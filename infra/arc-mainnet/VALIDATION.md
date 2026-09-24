# Arc validation — 2026-09-24

## Authorized mainnet deployment and Safe activation

All seven planned contracts were deployed with the Ledger after the operator
authorized launch and chose a verified encrypted backup on this Mac mini.
Deployment consumed 8,136,148 gas and 0.162722960008136148 native USDC.
Settlement is `0x78799F98276efba1EdeeD32eae03a3fd8Cdfec3A`; authenticator is
`0xBA352C486B526886fDe4D15f3d3c9aC67Eca9d59`.

The Safe authorized solver `0x839029e110F4954e05aFad4Fa222CfE93ce6d86f`
at block **22516917**, transaction
`0xbad31b4a400b97db748807face9ede4ab4401a1a2c3081bfe08ef93f46135ca1`.
`verify.cjs` passed independently against both free RPCs: successful deployment
receipts, creation calldata, runtime code, official 2-of-3 Safe authority with no
modules, solver authorization and settlement/vault/relayer/domain/hooks wiring.
The solver held **0.45005359 native USDC** at block 22517168.
Ignored `release/generated/verified.json` and `solver-activation-receipt.json`
record the checks. Do not regenerate the deployed plan or resubmit either Safe batch.

The local encrypted backup was restored and checked by address and signing.
Off-site backup remains unverified, consistent with the operator's explicit
same-Mac choice. The empty production RAM key mount's Colima metadata cache
issue was cleared once; its Docker marker/permissions probe now passes. Existing
OP services were not restarted. The operator then prepared the actual RAM key;
startup independently verified its identity/provenance and launched the backend.
All 110 database migrations passed. The indexer caught up from deployment using
a temporary five-second poll, then returned to the configured 30-second cadence.

The public API `https://arc-mainnet.ophis.fi` returns the expected release
`7f2f8b10f2e1`, a current auction, and a simulation-verified quote with correct
swap-origin CORS. A 10 USDC quote returned 8.789004 EURC at 20.1 gwei. This is
simulation evidence, not an executed swap. The Arc tunnel and proxied DNS record
were created with existing Cloudflare credentials; no additional paid plan.

Live startup exposed two configuration gaps, now fixed and independently
reviewed: the driver's default Alloy estimator exceeded the reviewed gas cap,
and raw latest-header queries raced between RPC providers. The renderer selects
the existing Web3 estimator with zero extra tip, retaining the 25 gwei cap.
eRPC now pins latest-header requests to the common served height before quorum.
The isolated pilot and release proxy tests passed, including skewed latest heads,
real header disagreement, missing voters, bypass rejection, cache behavior and
paid-lane accounting. Live served heights advanced across polling cycles.
An isolated active render checked estimator, zero tip, cap and guarded signer.
No backend binary or contract changed for these fixes. QuickNode usage was
120 credits after startup and one proxy restart; dRPC was not used by Arc.

The production swap and explorer builds passed with isolated, frozen offline
dependencies and more than 8 GiB free. A previously undeclared address import
now uses the library's existing ethers dependency; its ten Arc configuration
tests and an independent dependency review passed. Browser checks of the built
swap app showed a verified 10 USDC/EURC quote, correct fee display and wallet
dialog without uncaught errors. Production bundles contain the deployed Arc
addresses and public API, with no Arc QuickNode endpoint or local API.
The browser's initial fast/optimal quotes exposed an ingress burst mismatch:
the burst is now five while the sustained global six/minute cap is unchanged.
The isolated Nginx regression admitted six immediate requests and rejected the
next two, with CORS and exact v2 routes still passing; independent review passed.
No credit cap or paid RPC permission changed.

The swap frontend is published at `https://swap.ophis.fi` (Pages deployment
`d834dccb.greg-etm.pages.dev`), and the explorer at `https://explorer.ophis.fi/arc`
(`1228a5ee.ophis-explorer.pages.dev`). Public browser checks confirmed the Arc
quote, wallet dialog and explorer's Arc account-order requests without uncaught
errors. The existing intent Function still returns HTTP 200. The deployment
helper's final check now targets the swap subdomain and current `app-*.js`
bundles; its old marketing-root/index-bundle check incorrectly exited after a
successful upload. Backend QuickNode usage remains 120 reserved credits.

No remote merge, push, live swap or bridge transfer was performed. Funded
swap/bridge validation remains pending. These frontend publications are manual;
the Arc branch must be merged before the next normal main-branch frontend
deployment, or that deployment will remove Arc activation. Today's production
wallet fixes and preceding UI changes were cherry-picked locally to avoid a
frontend rollback. Earlier automatic
settlement tests used disposable Anvil and labelled 1:1 liquidity fixtures.
Real Uniswap liquidity was checked separately in [LIQUIDITY.md](LIQUIDITY.md).

## Earlier preparation review — September 24 (before deployment)

The existing Mac mini is selected for Arc. A fresh dedicated solver,
`0x839029e110F4954e05aFad4Fa222CfE93ce6d86f`, was imported into the existing
isolated `ophis-driver` account, as confirmed by the operator on September 24.
The importer verifies identity and owner-only file permissions; an independent
assistant recheck remains unavailable because noninteractive sudo still requires
authentication. The encrypted staged key remains recoverable by the operator
account until verified off-site backup and staging cleanup. No backup completion
is claimed: the operator confirmed the backup is **not yet done**. No existing
chain's key was reused. Encrypted staging is retained; solver funding remains pending.

The disk blocker was resolved by removing about 10 GiB of this checkout's
rebuildable Rust intermediates, preserving hashes of all four native binaries.
The production backend and migrations images built successfully from backend
code revision `7f2f8b10f2e1`, beginning with 14.3 GiB free. Two Cargo jobs,
locked dependencies, disabled debug information and a 3 GiB stop bounded the
build. The backend image's five binaries passed offline CLI checks as UID 501;
the direct V3 command is present. Flyway's offline version check passed.
`release/generated/production-images.json` records both arm64 image IDs and
checks. No Arc services were activated.

The selected Colima instance runs as UID 501 and cannot directly mount the
isolated UID 502 key. Mac startup now requires a separate owner-only RAM copy,
using OP's existing hdiutil approach, with exact RAM device/mount provenance,
Spotlight exclusion and planned-key binding. The canonical key remains under
UID 502; the operator and Docker administrators can access the runtime copy.
It must be recreated after reboot. A real disposable-key test proved Colima's
read-only mount works as UID 501:20 with no networking. Rapid reuse of a detached
RAM device number exposed a Colima stale-mount cache issue; a fresh device passed.
A Docker marker/permissions probe must therefore pass before actual key copying
or startup. No actual solver key was used in these tests, and Colima/OP were not
restarted. Production RAM preparation remains an operator step; a failed mount
probe requires host maintenance, not bypassing the guard.
Trail of Bits workflow implementation review and independent QA review passed
the final host-tool changes. The real-entrypoint regression proves a failed
Docker probe prevents sudo, key reads/writes, RPC, rendering and activation.
The existing Pashov contract review remains applicable: no Solidity or backend
source changed in this host preparation pass. RAM storage is not a guarantee
against OS swap/hibernation. All scratch devices and mounts were cleaned up.
After building, 3.6 GB of disposable Docker compiler cache was pruned and free
guest blocks were trimmed; production images, existing containers and database
volumes were preserved. The final disk check showed approximately **10 GiB free**.

The actual Safe, deployer and solver are bound to the prepared unsigned plan:
`0xf847a22abd920e48c88906ead95e39be4f5673433e378f0903cfe2289e01fcc0`.
Both free RPCs passed governance and reported deployer nonce zero and 0.3 native
USDC at **10:23:49 UTC**. Seven deployment caps total **0.245375 USDC** at
25 gwei; runtime solver startup separately requires **0.25 native USDC** at the
configured gas limit and fee cap. Refresh all onchain observations before signing.

| Requested review | Scope and result |
| --- | --- |
| Trail of Bits secure-workflow / differential review | Release plan, activation, signer custody, startup and RPC budget boundaries. Fixed release overwrite and stale Safe-batch hazards. Final staged-key importer review found no actionable defect. |
| Pashov Solidity auditor v3 | All 12 specialty reference lenses applied in grouped passes; deployed Solidity dependencies, authority, signatures, native USDC arithmetic and direct DEX execution. No confirmed exploitable finding or unresolved actionable lead in this pass. |
| Ethskills QA | Frontend, explorer, native gas handling, direct swaps, bridge status and activation. Fixed missing explorer trades route and direct-URL TWAP guard. Public launch still requires actual deployment and live swap/bridge validation. |

These are skill-guided AI/tool reviews, **not approval or certification by the
named firms**. Pashov v3 was the installed version; this was not a 12-independent-
agent audit. Earlier findings and accepted boundaries remain recorded below.

The final review fixes prevent release-plan replacement, validate the exact Safe
activation batch, expose only the required `/api/v2/trades` route with the existing
CORS policy, and explicitly disable TWAP review/confirmation on unsupported
chains. The importer binds the encrypted key to the plan, uses a stdin pipe for
the isolated account, and creates owner-only files exclusively; no key goes into
arguments or logs. Regression checks run in CI where platform-independent.

Fresh checks passed: solver provisioning/import and overwrite regressions; plan
preservation and activation binding; seven-contract local Safe rehearsal;
release preview/activation rejection; Linux file ownership; actual Nginx route,
CORS and quote throttling; credit accounting and two-voter RPC failure boundaries.
The new TWAP suites passed **7 tests** and frontend TypeScript passed. Fresh
Slither runs on Balances and Signatures used **101 detectors** each and reported
only informational assembly/pragma findings. Arithmetic review exercised
100,000 direct-output cases, 100,000 settlement-floor cases and native boundaries.

HooksTrampoline creation bytecode and ABI matched the pinned
[upstream artifact](https://github.com/cowprotocol/services/blob/cfbec985dfe476bf7ef42750435f7d5a12223a85/contracts/artifacts/HooksTrampoline.json);
its [source](https://github.com/cowprotocol/hooks-trampoline/blob/de9bf6d844a26a3a945afc511d4ccf877a9b654e/src/HooksTrampoline.sol)
was reviewed but not independently rebuilt with solc 0.8.20. EIP173Proxy creation
and runtime bytecode matched the repository-pinned
[hardhat-deploy 0.11.26 artifact](https://unpkg.com/hardhat-deploy@0.11.26/extendedArtifacts/EIP173Proxy.json).

The fresh free-RPC direct Uniswap check passed with **21 requests** and no
transaction; see LIQUIDITY.md. All local tests used zero public RPC, QuickNode or
dRPC calls. No paid credits were used by preparation. Production Docker images
are now built; approximately 10 GiB remained after cache cleanup. Verified off-site backup,
production RAM-key preparation, solver funding, deployment and Safe
activation, service publication and live swap/bridge smoke tests remain launch
operations. Nothing was broadcast, merged or pushed.

## Governance choice and unsigned batch — September 24

At **10:08 UTC**, both free RPCs confirmed **0.3 native USDC** on the deployer,
pending nonce zero and passing governance checks. Local deployment gas totaled
8,136,136; both RPCs quoted 20.1 gwei, implying about 0.163536 USDC at that price.
Replaced the oversized per-transaction default with measured creation limits
plus at least 20% margin, enforced in the full rehearsal. The seven limits total
9,815,000 gas; at the new 25 gwei default cap their combined maximum is
**0.245375 USDC**. The broadcaster checks the current gas price against the cap
before each send. The fresh seven-contract rehearsal, solver checks and release
preview/activation-rejection/permissions/HTTP checks passed. No public transaction
was sent; no QuickNode/dRPC credits were used. At that earlier point the production
solver and final production plan were absent; both are now prepared as recorded
above; the operator subsequently confirmed successful isolated-account import.

Following the operator's confirmation, read-only checks through both free Arc
RPCs at **09:58 UTC** passed: the Safe has all three expected owners, threshold
two, no modules, and the official SafeL2 1.5.0 runtime. This resolves the prior
governance mismatch. At that earlier check the deployer had zero native USDC and
pending nonce zero; the subsequent funding is recorded above. The
ignored `release/generated/safe-preflight.json` records this check and is **not**
a contract deployment verification record. No transactions were sent by the
assistant, and no QuickNode/dRPC credits were consumed.

The operator chose to retain 2-of-3 by adding the existing Ledger owner to the
supplied Arc Safe. `release/safe-governance.json` encodes one zero-value Safe
self-call to `addOwnerWithThreshold(deployer, 2)` on chain 5042. No public
transaction was signed or sent. The local rehearsal now starts a real Safe at
1-of-2, rejects its initial state against the launch checks, executes the exact
proposed calldata, verifies all three owners and threshold two, rejects duplicate
addition, and confirms a single owner cannot authorize the solver afterward.
The remaining deployment, settlement and revocation rehearsal also passed.
This run used zero public RPC calls and zero paid credits. The local Safe fixture
is the vendored 1.3.0 implementation; this is not an execution against the live
1.5.0 Safe. The live governance state was subsequently verified as recorded above.

## Release package completed locally — September 23

The operator supplied Arc Safe `0x858f0F5eE954846D47155F5203c04aF1819eCeF8`
replaces the earlier assumed cross-chain Safe address. Both free Arc RPCs agreed
at block 22379061: deployed SafeL2 1.5.0, official singleton runtime hash, no
modules, two owners and threshold one. The verifier now pins official 1.5.0
Safe/SafeL2 hashes from safe-deployments v1.37.50. The existing three-owner,
two-signature requirement is unchanged. The initial governance mismatch was
resolved and verified on September 24 as recorded above. These reads used no
QuickNode/dRPC credits or transactions.

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
