# Ophis Milestone A decision packet

**Date:** 2026-08-17

**Branch:** `codex/ophis-priority-lab` (local only, no upstream)

**Publication/deployment:** None

## Executive decision

Milestone A has produced a useful Ophis-owned research and safety foundation,
but it does not support adding a new execution lane.

**Decision:** keep the read-only controls and local prototypes; do not promote,
enable, push, deploy, or release them. Continue shadow measurement only after
review. The execution gate remains closed because the current quote fixture is
unreliable on USDC cases, aggregate calls can exceed provider gas caps, and the
observed gross price improvements have narrow or negative gas margins.

No source-returned calldata is trusted by Ophis, and none of the new packages
can submit a transaction.

## Six priority workstreams

| Priority | Local outcome | Decision |
| --- | --- | --- |
| 1. Source and chain provenance | Ethereum manifest, exact-block reads, runtime hashes, dependency wiring, and reorg checks | Keep |
| 2. Quote redundancy evidence | Read-only aggregate fixtures, 10-case and 30-case matrices, failure preservation, provider comparisons | Keep in shadow only |
| 3. Independent price and economics controls | Direct V2, V3, and hookless V4 baselines; historical replay; time series; break-even gas model | Keep; no execution promotion |
| 4. Wallet capability safety | Active-chain parsing, stale-result invalidation, provider replacement, uncertain-submission stop, no silent replay | Keep; finish status reconciliation before UI promotion |
| 5. Onchain discovery | Ethereum-only, display-only panel, disabled by default, strict runtime/wiring/row validation | Keep disabled pending product and security review |
| 6. Ophis Lite fallback | Deterministic, dependency-free, non-interactive HTML prototype and versioning ADR | Keep as local architecture; contracts, wallet, and order flow remain deferred |

## Direct research trace

### Source and deployed quote stack

The source repository was reviewed directly at commit
`949d43bfafea78d71a8a22b85057724383caf525`. The current, prior, and fixed
quote fixtures and their dependencies were then checked against live Ethereum
runtime bytecode. Ophis did not rely on the report's deployment table alone.

Independent controls use official interfaces:

- [V2 router interface](https://github.com/Uniswap/v2-periphery/blob/master/contracts/interfaces/IUniswapV2Router01.sol);
- [V3 quoter interface](https://github.com/Uniswap/v3-periphery/blob/main/contracts/interfaces/IQuoterV2.sol);
- [V4 quoter interface](https://github.com/Uniswap/v4-periphery/blob/main/src/interfaces/IV4Quoter.sol); and
- [V4 pool-key definition](https://github.com/Uniswap/v4-core/blob/main/src/types/PoolKey.sol).

All 15 contracts in the final Ethereum manifest matched their pinned runtime
hashes at block `25774340`.

### Developer-described parent application

The article was treated as a set of claims and checked against the deployed
Ethereum contracts and returned application bytes.

Reviewed application root:

- address: `0x00000095643CFfA7D9fae407a84dfCB6406456c6`;
- runtime hash:
  `0xf1a609bf999244522bbd702a6a755d344f76effdcb5d98f0269b72ccaaf8ebee`;
- `generation()` returned `1`;
- `latest()` returned the root itself;
- runtime selectors include `html()`, `request(...)`, ten data-chunk getters,
  and `deployNext(...)`.

Reviewed resolver:

- address: `0x000000E7DAD6128683D1fb415e80B30c23dAb7AC`;
- runtime hash:
  `0xd7f69e747da383a11ad20d24f5839ed379c83276357f1f760878d3aeb1e6b17b`;
- `ROOT()` and `current()` returned the reviewed root;
- `MATURITY()` returned `259200` seconds, or three days.

The root returned 240,946 decoded HTML bytes. Direct inspection found no
`fetch`, XHR, fixed RPC-provider URL, or HTTP quote API. Blockchain reads and
wallet calls route through `window.ethereum`. The page does contain external
verification and gateway links, so the narrow claim “no embedded RPC or quote
API” is supported; broader “nothing external matters” language is not an
appropriate Ophis claim.

The application also accepts quote-builder calldata, performs direct router
execution, and contains EIP-2612, Permit2, wallet-call batching, and stepped
approval paths. This confirms that approval abstraction is an application-wide
workflow, not something the quote builder handles by itself. Ophis keeps the
UX goal but does not copy the execution trust boundary.

The root exposes a general resource-request selector and an `html()` getter,
but the claimed numbered HTML standard was not found in the canonical Ethereum
ERC repository. Ophis therefore keeps its interface and versioning design
Ophis-specific and does not claim compliance with an unverifiable standard.

## What Ophis keeps from the report

1. API-independent onchain quoting as a redundant signal, while explicitly
   disclosing the wallet or node RPC dependency.
2. Fixed-version, content-hashed fallback UI artifacts, with an optional
   delayed resolver that is never the immutable trust anchor.
3. Chain-specific address and runtime pinning at every dependency layer.
4. Same-block quote comparisons, shadow mode, explicit failure metrics, and
   staged promotion gates.
5. Better approval UX through permits or wallet batching when capability is
   unambiguous on the active chain.
6. Onchain metadata as a discovery input, never as token safety proof or
   automatic list activation.

## What Ophis modifies

1. “No fee” becomes “no added router surcharge.” Venue fees, gas, failure
   risk, and solver cost remain.
2. “API free” becomes “no third-party HTTP quote service.” Ethereum RPC is
   still required and provider gas caps affect availability.
3. A future pilot, if ever approved, starts with standard ERC-20, exact-input,
   single-hop routes and locally encoded calls. Returned opaque calldata is not
   accepted.
4. Wallet batching is an optional interaction tier. It is not described as
   atomic settlement, and uncertain submission never triggers automatic replay.
5. Token registry rows are plain informational data until separate token
   behavior, liquidity, and settlement reviews pass.
6. Every additional chain gets its own provenance, fixtures, economics, and
   approval decision.

## What Ophis rejects or defers

- immediate router integration;
- arbitrary returned calldata, nested multicalls, splits, or executor calls;
- sentinel or unbounded deadlines;
- native-currency, hooked-pool, exact-output, and multi-hop expansion;
- non-ERC-20 asset IDs in the existing order model;
- fee-on-transfer, rebasing, sender-tax, or deceptive tokens;
- generic approval, sweep, deposit, wrap, unwrap, or permit selectors;
- assumptions that addresses or venue sets are identical across chains;
- marketing claims that UI availability makes order submission, solver
  competition, or settlement services fully onchain; and
- using quote latency or selective router benchmarks as proof of user surplus.

## Ethereum evidence

The 30-case Ethereum matrix covered WETH, USDC, DAI, USDT, WBTC, wstETH, and
rETH in both directions.

- Fixed and prior aggregate fixtures: 30/30 success and identical successful
  outputs.
- Current aggregate fixture: 20/30; all ten USDC-related cases reverted.
- Direct V3 baseline: 30/30.
- Direct V2 baseline: 30/30, including economically poor low-liquidity quotes.
- Direct hookless V4 baseline: 10/30 because absent/unquotable allowlisted pools
  fail instead of falling back.
- A second provider rejected one heavy aggregate case above its 50,000,000 gas
  cap.

At block `25774279`, aggregate output beat V3 in only 3 of 30 cases, by
0.24–1.18 bps gross. Direct historical calls reproduced both V2-labelled wins
and the V4-labelled win exactly.

At block `25774384`, the only candidate win broke even at 23,558 incremental
gas under an explicit 1 gwei scenario. It was already negative at the smallest
tested 25,000-gas increment. Historical 1 gwei break-even thresholds were
1,472, 61,741, and 12,649 gas for the three earlier wins. These margins do not
justify execution work without measured settlement gas.

## Other-chain rule

Nothing in this packet enables another chain. A chain must not inherit
Ethereum addresses, runtime hashes, venue sets, registry state, token policy,
or gas economics.

Before adding a chain, Ophis requires:

1. a chain-specific manifest for every quote source, helper, pool manager,
   factory, registry, and lens;
2. verified source provenance and live runtime hashes from at least two
   independent RPC providers;
3. exact-block quote and reorg tests;
4. a standard-token allowlist and chain-specific wrapped-native definition;
5. active-chain wallet-capability tests;
6. a 30-case-or-larger matrix over representative local liquidity;
7. native-gas break-even scenarios and measured full-settlement simulations;
8. an independent security review; and
9. explicit product approval.

The upstream Base configuration already differs from Ethereum in router,
helper, and venue wiring. Optimism and other chains have no reviewed Ophis
fixture in this milestone. They are separate integrations, not configuration
copies.

## Promotion gates

| Gate | Status | Evidence or blocker |
| --- | --- | --- |
| Provenance and runtime identity | Pass for local Ethereum reads | 15/15 manifest runtimes matched |
| Quote reliability | Fail | Current fixture 20/30; deterministic USDC reverts; provider gas-cap failure |
| Gross economic improvement | Weak | 3/30 historical wins, only 0.24–1.18 bps |
| Net surplus | Fail/unmeasured | Most scenario margins negative; no full settlement gas measurement |
| Execution safety | Not started | No local encoder, validator, or settlement simulation authorized |
| Wallet retry safety | Partial | Capability hardening complete; calls-status reconciliation remains |
| Token safety | Display-only | Discovery cannot activate or route a token |
| Other chains | Not started | No chain-specific manifests or evidence |
| Independent audit and canary | Not started | Required before any execution promotion |

## Local verification and commits

Implementation commits before this packet:

1. `e6b61466` — Ophis priority foundations
2. `66c57c92` — wallet capability hardening
3. `137b3917` — onchain discovery boundary
4. `2c285039` — V3 quote baseline
5. `4d4f6a74` — expanded quote matrix
6. `92b62702` — V2 quote baseline
7. `7a17d6ec` — V4 quote baseline
8. `81bf9703` — quote time series
9. `aa67efa0` — break-even quote economics

Key validation:

- Ophis Quote Lab: 14 tests; targeted Clippy passed with only two pre-existing
  workspace-config warnings.
- Wallet capability work: 21 focused tests plus frontend type checking.
- Discovery boundary: 25 focused tests plus frontend type checking.
- Ophis Lite: deterministic build, manifest verification, negative fixtures,
  desktop/mobile inspection.
- Repository-wide case-insensitive scan found no forbidden external branding.

## Approval boundary and next decision

No remote branch was created because Git branches are not private objects. All
work remains on the local branch with no upstream.

Explicit approval is required before any of the following:

- push or pull request;
- enabling a feature flag;
- adding a route to solver eligibility;
- building an execution adapter or approving a validator scope;
- deploying a contract or static root;
- running a funded transaction, canary, release, or production experiment.

Recommended next action: review this packet and decide whether Ophis should
continue read-only multi-provider sampling or stop this integration track. The
current evidence supports shadow research, not execution development.
