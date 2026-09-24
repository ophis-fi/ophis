# Local Arc lab

This is a local build, not a mainnet deployment. It runs Circle's Arc Anvil
without a fork, disposable PostgreSQL, the real Ophis orderbook/autopilot/driver/
direct Uniswap/Synthra/AchSwap V3 solvers, and deterministic onchain liquidity fixtures. It needs no hosted node,
public RPC requests, QuickNode credits, dRPC, PartnerPage key or paid service.

## Run

Install the frontend's locked dependencies (`pnpm install --frozen-lockfile` from
`apps/frontend`) and the repository's pinned Rust toolchain. Docker is needed for
Solidity compilation and the disposable database. Build the existing migration
image if it is absent:

```sh
docker build --target migrations -t backend-migrations:latest apps/backend
python3 infra/arc-mainnet/local/build.py
python3 infra/arc-mainnet/local/run.py --anvil /path/to/arc-foundry/anvil
```

The build helper uses two Cargo jobs, disables debug information and incremental
artifacts, and reuses the existing target directory. It stops before building if
less than 3 GiB is free (12 GiB for a fresh target). These are conservative initial
checks, not a disk reservation; other processes can still consume space. Run the
guard alone with `build.py --check-only`; its check is `python3 infra/arc-mainnet/local/test_build.py`.

Disk check on 2026-09-22: only 725 MiB was free initially. Removing unused Docker
build cache (4.91 GB) and trimming unused Colima VM blocks brought this to about
10 GiB. Images, containers, volumes, source files and other worktrees were kept.

Use **Arc Foundry v0.8.0-2** from [Circle's release](https://github.com/circlefin/arc-foundry/releases/tag/v0.8.0-2),
not standard Anvil. Verify the release checksum. The macOS arm64 archive used here
has SHA256 `90e3eefbf7dd80652fd283a7562e9263301a48797bc2224cc21a3964e2d5db87`.
In this workspace the executable is `/private/tmp/ophis-arc-foundry/anvil`.

The runner refuses occupied ports, uses only `127.0.0.1`, checks chain ID 5042 and
Anvil identity, refuses a fork, and cleans up its own processes/database. No remote
RPC argument or production signing key is accepted. Local contract addresses,
service configuration and logs are written under gitignored `generated/`.
The default driver uses an address-only account and **cannot sign transactions**.
For automatic local settlement, add `--automatic-settlement`. This derives only
Anvil's public disposable solver key, checks its address, and uses the existing
policy-guarded signer for the local settlement. The ignored key file has mode
0600 and is removed on shutdown. No external key or RPC input is accepted.
`python3 infra/arc-mainnet/local/test_render.py` checks these configuration guards.

By default the three direct DEX regression solvers run. Use `--uniswap-only`
to run just the venue supported by the live verification results and reduce RPC work. Add `--with-kyberswap` or
`--with-lifi` (or both) for optional competing aggregators. These start only
loopback HTTP fixtures, with no public API calls. All modes use the existing
Ophis quote and auction competition, with no new routing service.

For a running frontend lab, add `--serve`; in a second terminal:

```sh
set -a
. infra/arc-mainnet/local/generated/frontend.env
set +a
cd apps/frontend
NODE_ENV=development pnpm exec nx run cowswap-frontend:serve:dev --host 127.0.0.1
```

Use disposable Anvil accounts and its loopback RPC. Select Arc (local), or use
`#/5042/swap`. Local Arc requires the local flag and both contract addresses. Production Arc
uses a separate verified deployment gate described in [../release/README.md](../release/README.md). No private provider URL
is shipped to the browser.

For the browser regression check, run the frontend on port 5179 (`--port 5179`
on the serve command above), keep the lab running with `--serve`, then run:

```sh
node infra/arc-mainnet/local/check_browser.cjs
```

This reuses installed Playwright/Chromium and blocks all external browser traffic.
It uses the fifth disposable Anvil account, selects a finite 10 USDC approval,
checks the typed-signature chain/contract and permit value, submits through the
real UI, and checks settlement of that exact signed order. It first rejects a
permit and the fallback approval, verifies unchanged allowance, and retries. The
accepted order must contain exactly one finite permit hook, and both Permit and
Order signatures must be observed. In automatic mode,
the solver/driver must submit it; the browser test never calls settle. The default
dry-run lab retains the earlier manual settlement check. Both check the signed
minimum output, full fill, zero remaining allowance, the solver's Trade event,
indexed `fulfilled` status and completed UI. Screenshot/result files are ignored
under `generated/`. Local order/account links point to the local orderbook API;
there is no public Arc Ophis explorer deployment.

## Implemented behavior

- USDC gas uses 18 decimals; the ERC20 at `0x3600…0000` uses 6. Native pricing
  converts by `10^12`, including the autopilot fallback. Balance overrides fund
  the holder's native balance and preserve the simulation helper's code.
- Orders use ERC20 addresses. The native sentinel is rejected. No WUSDC,
  wrapping, EthFlow, or bridged-WETH-as-gas assumption is introduced. Max USDC
  leaves 1 USDC for local approval/cancellation gas; this is a fixed development
  reserve, not a guarantee for future mainnet gas conditions.
- Direct Uniswap V3, Synthra V3 and AchSwap V3 are separate competing solvers. They read
  pinned factories/QuoterV2 contracts over RPC and build router calldata locally;
  no DEX API or aggregator supplies the route. Uniswap and Synthra use Router02; AchSwap
  uses the legacy router with a deadline. Driver guards independently enforce
  the configured settlement recipient, tokens, amounts, approval and zero value.
- Direct routes initially cover USDC/EURC SELL orders in both directions, with
  fee tier 500 for Uniswap and tiers 100/500 for the other lab venues. Missing pools are skipped.
  Uniswap needs at most four RPC requests per uncached search. The other venues need at most six
  RPC requests per uncached route search: chain ID, block header, two pool
  lookups and up to two quotes. Simulation/backend reads are additional. No
  factory event scans, indexer or hosted node are required. Queries use one
  canonical block hash per search; there is no stale quote reuse.
- LI.FI and KyberSwap are off by default. Their flags add them to the same competition as the
  direct venues, without giving it priority or making direct routes depend on it.
  Their authenticated Arc routers are allowlisted with the existing checks.
  KyberSwap reuses the existing two-request routes/build connector and settlement
  simulation. Public API quotas and simulation RPC costs still apply outside this lab.
- Direct Uniswap V4, OpenOcean, 0x and 1inch are not enabled in this build.
  Uniswap V4 deployments are published, but the existing Ophis V4 adapter assumes
  native ETH/WETH; Arc's ERC20 USDC pool needs separate adaptation. OpenOcean's
  current first-party contract table did not list Arc. No address is inferred
  from a screenshot or quote response. The V3 routes above work independently.
- The lab installs labelled ABI-compatible V3 fixtures at the documented venue
  addresses. These test routing, calldata and settlement, not AMM tick math or
  live pool depth. Separate [live read-only checks](../LIQUIDITY.md) verified
  Uniswap's 500-fee pool and both router directions. These checks do not establish
  execution through an eventual mainnet Ophis settlement.
- Across uses canonical 6-decimal USDC as the Arc destination. Ethereum,
  Arbitrum and Base are supported executable source chains in the existing
  provider. Arc is not advertised as an outbound bridge source. Cross-decimal
  routes remain rejected. Unit tests mock API responses; the separate bridge check
  below also validates a live quote and the unsigned SDK hook. No funds are bridged.
- Arc settlement events use existing log decoding and storage with at most 100
  finalized blocks per range request. The cursor and range-end hashes are checked;
  regressed heads or inconsistent checkpoints fail closed. Other chains keep the
  original reorg-aware indexer. Local polling is 30 seconds, concurrency is bounded,
  and native prices are cached. The separate eRPC pilot retains strict provider limits and no dRPC leg.

The local authenticator is initialized directly and solver-allowlisted. The
settlement uses a reverting vault fixture: ERC20 orders work; Balancer internal/
external balances are not provided. Production governance/proxy deployment,
live liquidity execution, a live bridge fill, and public transaction-relay enablement
are outside this local-only build. No mainnet contract address is invented.

## Checks completed (2026-09-22)

- Four Rust service binaries compiled; frontend TypeScript check and development
  bundle passed.
- Arc native-balance override/overflow and price-scaling Rust tests passed.
- Event-indexing tests: 14 passed, 5 existing live-network tests ignored. Added
  coverage for bounded catch-up, empty ranges, failed log reads, regressed heads
  and changed checkpoints without unsafe cursor advancement.
- Local GPv2 settlement delivered EURC for USDC and rejected an unauthorized solver.
- Real orderbook returned verified quotes, including an amount exceeding the
  trader's balance; checked native/USDC fee units and native-sentinel rejection.
- Real orderbook accepted an EIP-712 order signed by the disposable local account.
- Browser approval/signing/submission/automatic settlement/completed-state test passed
  with both three direct lanes and the Uniswap-only configuration.
  It exposed and fixed missing Arc stablecoin, order-link and progress-message
  entries that typechecking alone did not detect. Permit support remains enabled;
  the finite 10 USDC permit was checked in the submitted appData and consumed fully.
- Direct router ABI and driver guard tests cover Router02, legacy V3 and existing
  Slipstream routes. Recipient poisoning, amount mismatch and bypasses are rejected.
  All 34 driver allowlist tests passed; KyberSwap regression tests passed (12,
  with 2 existing ignored tests), including Arc endpoint selection.
- All three direct lanes quote in both directions. Competition chooses the better
  output and remains available when one venue has no quote. Both direct-only
  and optional aggregator modes are exercised locally.
  Each enabled optional connector is also quoted independently in both directions.
- Across/Arc/NEAR bridge regression tests: 44 passed with the repository's SDK
  patches applied. No bridge transaction was submitted.
- Isolated eRPC tests passed: quorum, no client bypass, header cache, weighted
  budget, bounded attempts and denied methods. Zero live RPC calls.

TypeSafe Jev supplied focused design judgments about units, ERC20-only trading,
reuse of Across/direct V3, independent settlement validation and readiness claims. Those judgments were advisory; transaction
logic, budget accounting and test assertions are deterministic.
No live bridge transfer was made. The unsigned hook check described below is
separate from the mocked unit tests.

## Automatic settlement, bridge and request checks

For the low-usage local candidate:

```sh
python3 infra/arc-mainnet/local/run.py --anvil /path/to/arc-foundry/anvil --automatic-settlement --uniswap-only --serve
# Start the frontend on 5179 as above, then:
node infra/arc-mainnet/local/check_browser.cjs
python3 infra/arc-mainnet/local/measure_rpc.py
```

The lab's fixed loopback meter on port 8548 forwards only to its Anvil on 8547.
All backend RPC requests use it; JSON-RPC batch elements count separately.
The meter never connects to a public provider. `measure_rpc.py` checks batch
accounting, measures 60 seconds idle and one verified quote, and refuses to label
an interval idle if it contains a transaction submission. Browser results include
backend counts for the complete UI test window; background/indexing traffic is
included, while browser/deployment/assertion RPC calls are excluded.

A five-block submission default expired before the old ten-second poll could
observe the local chain. The lab now allows 120 **one-second Anvil blocks**, with
30-second polling and a 20-second solver window. This is a lab timing setting;
mainnet's different block cadence requires its own measured deadline. Slower
polling trades some execution/status latency for lower RPC use.

Bridge checking reuses the installed, patched Across SDK and never constructs a
signer. The first run explicitly opts into one HTTP fee quote:

```sh
node infra/arc-mainnet/local/check_bridge.cjs --live
# Replay the saved quote and rebuild/inspect the hook without network requests:
node infra/arc-mainnet/local/check_bridge.cjs
```

It verifies Base/Arc USDC addresses and six-decimal amounts, fresh quote time,
limits, both documented SpokePools, and every Weiroll command in the unsigned
hook: balance lookup, fee math, exact spender, recipient, destination chain,
input/output bindings, empty message and deadlines. The adapter rejects all RPC
calls. This establishes quote/calldata consistency, not execution of the hook on
Base or delivery on Arc. Across now labels suggested-fees as legacy; Ophis reuses
its existing SDK integration, which still returned this route. Migration to the
Swap API remains separate work before relying on long-term API support.

Execute that recorded bridge leg offline with the committed Weiroll VM:

```sh
node infra/arc-mainnet/local/check_bridge_execution.cjs
python3 infra/arc-mainnet/local/check_security_properties.py
```

These checks reuse installed Foundry and solc-select compilers 0.8.28/0.8.30;
they do not install dependencies or call public RPCs. The execution check owns a
fresh, non-forked Anvil on loopback port 31557 and refuses an occupied port.
It uses fixture source token, execution host and SpokePool, plus the repository's
Across math helper. It checks the actual VM's deposit arguments, input transfer,
consumed allowance and complete rollback on an expired deadline or downstream
failure. The property check runs the existing helper tests with 1,024 fuzz cases
and verifies the committed VM's deterministic address. The live fork test is
explicitly skipped. Both clean up their temporary chain/build workspace.

This is the bridge **leg** of the existing source-swap-plus-bridge flow, for
example Base WETH → USDC → Arc USDC. The current frontend does not support a
same-token source swap, so the Base USDC → Arc USDC SDK check is not a direct
bridge-only UI flow. Actual Base execution and delivery on Arc remain unverified.

## Complete local browser corridor

With the lab running in `--automatic-settlement --uniswap-only --serve` mode
and the frontend on port 5179, run:

```sh
node infra/arc-mainnet/local/check_bridge_browser.cjs
```

This starts and stops a separate, non-forked Base Anvil on loopback port 31557.
It reuses installed Playwright, Foundry and solc 0.8.28/0.8.30. It does not need a
saved live quote or make public API/RPC calls. Do not run the standalone bridge
execution check at the same time; it owns the same source-chain port.

The same browser wallet sells 0.05 fixture WETH for 100 USDC on local Base,
signs and executes the committed CoWShed factory/implementation and Weiroll VM,
waits in the visible bridge-pending state, receives 99.9 USDC on local Arc, then
switches through the network selector and swaps 10 USDC for EURC through the real
Ophis orderbook, solver and driver. The Arc wallet starts with zero USDC. The test
requires the exact order's Trade event, filled amount, solver transaction, signed
minimum output, consumed finite allowances and completed UI. A repeated bridge
hook must revert with `NonceAlreadyUsed`.

Base quotes/settlement, the SpokePool and Across status/relayer are explicit
fixtures; the source settlement validates the order signature in the harness,
not in the fixture contract. Arrival uses a local USDC transfer, not a live Across
fill. Arc liquidity remains the existing deterministic venue fixture. Results and
pending/received/final screenshots are written to ignored `generated/bridge-browser-*`
files. Public Base execution and live bridge delivery still require separate
validation outside this local-only task.

See [measured results](../VALIDATION.md) for usage and remaining limits.

## Sources

- [Arc contract addresses](https://docs.arc.io/arc/references/contract-addresses)
  and [porting contracts](https://docs.arc.io/arc/tutorials/porting-contracts-to-arc).
- [Arc gas and fees](https://docs.arc.io/arc/references/gas-and-fees).
- [Arc event indexing and deterministic finality](https://docs.arc.io/integrate/infrastructure/indexing-events).
- [Across deployed contracts](https://docs.across.to/chains-and-contracts) and
  [suggested-fees API status](https://docs.across.to/api-reference/suggested-fees/get).
- [LI.FI's Arc deployment record](https://github.com/lifinance/contracts/blob/main/deployments/arc.json),
  used for router provenance rather than trusting quote responses.
- [Across's Arc destination routes](https://app.across.to/api/available-routes?destinationChainId=5042),
  checked read-only on 2026-09-22; availability must still be checked when quoting.

Direct venue provenance checked on 2026-09-22:

| Venue | Factory | QuoterV2 | Router |
| --- | --- | --- | --- |
| Uniswap V3 | `0xf0db7b58379503491d857dB50AC9ece64c653918` | `0x7DfD4F31be6814D2906BDE155c3e1B146EAc1468` | `0x53BF6B0684Ec7eF91e1387Da3D1a1769bC5A6F77` |
| Synthra | `0x6307fc239C7964942c1BfFE51930E55606619c74` | `0x9c179A7335B3fc841F59Aa6a62daf6d5c61b65D7` | `0xa50eDe66a573eE5bB37E28AF5789B76aE5FEb828` |
| AchSwap | `0xaE54BF4C8078BaAAf7e17f8e01659Ea470a989FC` | `0x659Da32F3F10566bDB6B55Ad84c182f1D00Ba058` | `0xEA0129203FBB99ebEea3f78B2d05b924f17FB556` |

Sources: [Uniswap's official deployment feed](https://developers.uniswap.org/deployments.json)
(chainId 5042, protocol v3), [Synthra's first-party deployment reference](https://docs.synthra.org/docs/contract-addresses)
(the content is client-rendered in its documentation bundle), and
[AchSwap's first-party deployment reference](https://docs.achswap.app/technical/contract-addresses/).
Offline builds/lab tests make no live RPC or quote-service calls. The separately
invoked live verifier and its exact request usage are documented in [LIQUIDITY.md](../LIQUIDITY.md).

KyberSwap's [explicit Arc contract entry](https://docs.kyberswap.com/developer-guide/aggregator-api/contracts)
pins MetaAggregationRouterV2 to `0x6131B5fae19EA4f9D964eAc0408E4408b66337b5`.
