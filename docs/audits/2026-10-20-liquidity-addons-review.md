# Direct liquidity add-ons: security review

Date: 2026-10-20. Baseline: `7523bc732e389718f8485ed6c738a356819949f9`.
Scope: Metric and Elfomo on Robinhood, the sixteen Ethereum f(x) Curve pools,
their shared RPC/driver boundaries, deployment configuration, frontend labels,
fork tests, numeric specification, and Railgun assessment. Railgun has no runtime
implementation in this change. Nothing was deployed or executed with live funds.

## Review status

The Pashov, Trail of Bits and Ponytail review passes have no remaining confirmed
findings or unresolved exploit leads in their reviewed scope. One availability
issue was corrected and the requested Elfomo regression coverage was added.
Independent Codex review of the initial forty-file snapshot returned no findings
and "patch is correct" (0.85 overall confidence). The four full-cycle cases pass,
and an independent test review closed both coverage gaps. The final Codex review
of all additions returned no findings and "patch is correct" (0.91 confidence).
All identified issues are resolved within the stated scope; this clears draft
PR preparation, not deployment or merge.
This is an engineering review using those methodologies, not an audit commissioned
from their authors, and does not establish the absence of vulnerabilities.

## Method and trust boundaries

Three independent review shards covered Pashov's twelve lenses in four-lens
groups: math/precision, access control, execution trace and numerical gaps;
invariants, boundaries, trust gaps and flow gaps; economics, periphery, first
principles and asymmetry. The installed Solidity Auditor v3 procedure was adapted
to production Rust and its EVM execution boundary. Only fork-test Solidity is new;
a native Solidity scan alone would not cover this implementation. Runtime agent
capacity was three reviewers, rather than the skill's twelve-agent arrangement.

Trail of Bits differential-review, audit-context-building, sharp-edges and
insecure-defaults guidance informed the review. Reviewers inspected the baseline,
relevant history/blame, changed functions and connected callers, then traced
malicious responses and calldata to concrete execution or rejection. Ponytail
review checked complete wiring, reuse of existing code and focused regression
coverage. No dependencies or production Solidity contracts were added.

The reviewed flow is config/chain validation → canonical-block quote → exact-input
swap encoding → existing simulation/solution conversion → driver fulfillment and
clearing-price context → protected-call validator → settlement. Solver responses,
RPC replies and calldata are untrusted inputs. The configured RPC and external
pool/token code remain operational dependencies; identity checks are not a proof
that a dishonest RPC or upgraded external implementation is safe.

Metric authenticates factory membership and token order for nine pinned pools;
Elfomo fixes the chain, settlement, router and quote caller; Curve authenticates
the ordered coins of sixteen pinned pools. Driver checks bind tokens, selector,
receiver, amount, output floor, exact approval, chain and fulfillment context.
Protected responses reject extra trades and supplied pre/post interactions.
Native buy amounts use the wrapped token's clearing price. Existing auction
hooks and final solution composition remain separate admission boundaries.

History inspection confirmed the canonical-hash read behavior from `8e7871b4`
was retained. Existing safety checks were not removed. The RPC error-payload
change was checked against all callers and compiled through the library suites;
the new explicit-caller request is used by Elfomo, while Metric retains its
intentional no-from quote request.

## Corrections during review

1. **Metric::quote revert classification. Closed.** The
   initial predicate required both a specific RPC code and the word
   `revert`. A code-3 response without that word, or `-32603: execution reverted`,
   became an infrastructure error instead of absent liquidity, so the existing
   solver did not retry a smaller fill. Metric now reuses the existing
   `is_revert_error_payload` helper, and `ReadOnlyRpc` preserves Alloy's complete
   error payload. Tests distinguish recognized reverts from rate limits, unknown
   failures and generic data-only errors; the latter remain RPC errors under the
   existing house policy. No demonstrated fund-loss path was identified.
2. **Elfomo::swap revert classification. Closed.** Its separate initial predicate
   had the same availability defect. It now uses the same existing payload
   helper, with separate regression coverage. This is a separate function-level
   disposition; no demonstrated fund-loss path was identified.
3. **Elfomo Rust negative-path coverage. Closed.** Deterministic RPC tests now
   assert settlement caller, canonical block, ordered tokens and exact input;
   decode the produced recipient, partner, amount, minimum and approval; exercise
   loose/tight limits; and reject malformed/zero outputs and unsupported orders.
   The fork test alone could not catch a defect in the separate Rust encoder.
4. **Numeric proof description. Closed.** Metric uses bounded checked U256
   arithmetic, unlike Curve/Elfomo's U512 floor. The description was corrected
   and a separate theorem checks Metric's numerator under its uint128 quote cap.
5. **E2e response relay negative control. Closed.** A zero router floor could
   fail an independent zero check rather than exercise the promised binding.
   The test now decreases a floor greater than one by exactly one, preserves
   reported output/prices, and checks the driver's `calldata_not_allowed` marker.
6. **Native probe buffer assertion. Closed.** Checking native ETH alone could
   miss an intermediate WETH buffer funding the unwrap. The probe now also
   requires the Settlement's WETH balance not to decrease on a native buy.

Completeness: the two function-level RPC availability leads above are both
covered and closed. The coverage gap and proof-description nits are recorded
separately; no unresolved exploit lead was silently discarded.

## Verification

| Check | Result | Boundary |
| --- | --- | --- |
| Driver library | 158 passed, 86 ignored | Complete library suite; environment-dependent tests remain ignored |
| Solver library | 197 passed, 14 ignored | Complete library suite, including the new RPC regressions |
| Shared Metric grammar | 4 passed | Canonical ABI encoding/decoding and route binding |
| RPC block-context tests | 5 passed | Caller, chain and canonical-block request behavior |
| Existing RPC classifier tests | 7 passed | House revert semantics reused by the new connectors |
| Fresh read-only propAMM tests | Passed | All nine Metric identities; Metric/Elfomo WETH–USDG quotes in both directions |
| Fresh read-only f(x) tests | Passed | Sixteen identities and thirty-two direct quotes |
| Pinned fork tests | 7 passed | Metric 3, Elfomo 2, f(x) 2; all sixteen Curve pools execute both directions |
| Real solver → driver → deployed settlement | 4 passed | Metric, Elfomo, Curve and Metric native buy; positive-floor negative controls and nonzero fees |
| Frontend registry Jest | 21 passed | Driver names and chain registry |
| Orderbook public-label test | 1 passed | Both new direct lanes retain the neutral public label |
| Registry invariant, Compose security, shell syntax | Passed | Service/config/frontend wiring |
| Changed-file ESLint | Exit 0 | Nx project graph unavailable, so module-boundary rule was skipped |
| Rust/Solidity formatting | Scoped pass | `pathviz.rs` has identical pre-existing formatter edits at baseline; left untouched |
| DirectLiquidity Verity/Lean | 8 theorems checked | Numeric specification only |
| Existing AllowListGuardian Verity/Lean | 38 theorem axiom checks | Separate access-control model regression |

Rust checks used locked offline dependencies, toolchain `1.96.1`, an isolated
Cargo target, three build jobs and no incremental/debug artifacts. The seven
fork tests use Robinhood block 93,311,122 and Ethereum block 26,232,714. Elfomo's
Nitro `ArbSys` block-number precompile is mocked in Foundry; other router/pool
calls execute forked deployed code. Metric execution forks cover WETH/USDG;
the other eight pinned stock pairs have identity and decoder coverage, not
individual execution forks.

The explicit-runner [full-cycle test](../../apps/backend/crates/e2e/direct_liquidity.cjs)
starts isolated real driver/solver processes, calls `/solve` and `/reveal`, then
executes the actual revealed settlement calldata through `eth_call`. Every case
asserts a nonzero solver fee, exact fee-inclusive seller debit, credited receiver
output and no traded-token buffer depletion. The native case also checks the
intermediate wrapped-token buffer and supplies the WETH price for a native order.
The final run used 90 read-only RPC requests and zero transactions:

| Scenario | Block | Solver fee (sell-token atoms) | Receiver output (buy-token atoms) |
| --- | --- | --- | --- |
| Robinhood Metric WETH → USDG | 93,371,949 | 9,166,482,860,000 | 214,524 |
| Robinhood Elfomo WETH → USDG | 93,371,949 | 10,013,303,118,000 | 212,529 |
| Ethereum Curve USDC → fxUSD | 26,233,115 | 28,665 | 961,725,156,223,705,922 |
| Robinhood Metric USDG → native ETH | 93,372,588 | 18,470 | 407,386,547,971,891 |

Calls use one fresh canonical block hash per scenario; gas estimates use that
block number. Trader ERC-1271 code, token balances and allowances are disposable
state overrides, with exact storage read-back assertions. The native USDG grant
fits its uint64 balance field. Ethereum additionally overrides solver ETH and
uses a temporary permissive authenticator; Robinhood retains its real
authenticator. This exercises execution under simulated Ethereum permission,
not actual CoW onboarding or authentication there. Only spawned subprocesses,
local servers and the invocation's temporary configs are cleaned up.

Reproduce with the built `driver`/`solvers` binaries, installed frontend ethers
dependencies and solc 0.8.30:

```sh
E2E_BIN_DIR=/path/to/target/debug \
NODE_PATH=/path/to/frontend/node_modules/.pnpm/node_modules \
node apps/backend/crates/e2e/direct_liquidity.cjs --live
```

Optional `ROBINHOOD_RPC`, `ETHEREUM_RPC` and `SOLC` select those read-only endpoints
and the compiler. The explicit flag permits at most 400 reads per scenario,
1,200 total; no signing or broadcast method is admitted by the proxy.

The new [numeric model](../../contracts/verity/DirectLiquidity/README.md) imports
Verity's `Uint256` at the existing pinned framework revision
`98533b72d2c93546e135d6b9e3aac08c5dbc06a8`, Lean 4.31.0. Its eight kernel-checked
theorems establish floor bounds, integer-width bounds and rounded-up payout
coverage **assuming actual delivery meets the minimum**. Axiom output contains
only Lean's standard `propext`, `Classical.choice` and `Quot.sound` as applicable,
with no `sorryAx` or custom axioms. This does not prove equivalence to Rust, ABI
correctness, RPC honesty, pool behavior, simulation or compiled bytecode.

Jev (`jev-latest`) checked source-supported implementation claims. Seven initial
claims scored 0.82–0.96; one combined Elfomo claim scored 0.63 because its excerpt
omitted the earlier positive-input guard. After splitting it, calldata binding
scored 0.88, the semantic positive-int256 description 0.53, and the literal guard
0.86; the regression-test description scored 0.66. These uncertain judgments
were escalated to an independent reasoning reviewer: `(U256::MAX >> 1)` equals
`2^255 - 1`, and the synchronous return precedes the first RPC await. The actual
BUY/zero/`2^255` regression passed. Port 9 alone is not proof of network absence;
the control flow establishes the pre-RPC rejection. No code defect remained.
The final runner mutation claim scored 0.91; native WETH-buffer and RPC-allowlist
claims were uncertain at 0.58 and 0.61. Independent source review and Codex
resolved these: the caller maps a native buy to address zero for the probe,
which snapshots and checks WETH; the anchored exhaustive RPC regex admits only
the listed read methods. All original and subsequent judgments were retained,
without rerolling identical claims to force a pass. These are evidence checks,
not a vulnerability oracle.

The Codex CLI skill's default `gpt-5.3-codex` and fallback `gpt-5.2-codex` were
unsupported by this account. The successful independent review used the configured
`gpt-6.1-sol` model with xhigh reasoning, read-only sandbox and structured output.
It inspected source and used prebuilt tests; the fresh coordinator-run checks
above remain distinct from what that reviewer independently executed.

## Practical limits

The four explicit full-cycle cases complement the Rust unit tests, driver guards
and pinned router execution forks. They do not cover orderbook/database/autopilot
auction orchestration, `/settle` submission, actual signing or broadcast, every
order type or every Metric pool. Simulation flags
also retain existing heuristic-gas fallback cases; they do not imply every
unavailable simulation fails closed. No full frontend build, repository-wide CI,
live funded transaction or independent audit of every external pool/token was
performed. No runtime dependency manifest changed, so a dependency scan was not
part of this differential review.

Ethereum hosted CoW auctions still require solver onboarding; adding this local
connector does not enroll it. Railgun remains an assessment, with SDK/broadcaster
compatibility and privacy-preserving order recovery requiring a separate
implementation and tests. The proposed asynchronous unshield/order/reshield flow
has public-order correlation and recovery limitations documented in the
[Railgun assessment](../development/2026-10-20-railgun-integration.md).

Raw review reports, hashes, prompts, Jev results and command logs are retained
locally at `/Users/scep/ophis-addon-evidence/04-audit/`. They supplement this
portable report and are not required to understand its conclusions.
