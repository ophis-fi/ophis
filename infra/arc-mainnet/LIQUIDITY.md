# Arc route verification — 2026-09-26

## New direct routes — implementation verified, not deployed

The release configuration now includes **Aero, Archery and Uniswap v4**, alongside
Uniswap v3 and KyberSwap. All are Ophis-operated lanes; the frontend identifies
the liquidity venue separately. No new contract deployment is required.

At canonical block hash
`0xe33181cd005fdcfa98cef7cd90170c8a399127696ebe0bc48fe22599789dcf6f`, the real
local driver called each new Rust solver. Its returned interactions were then
executed through the deployed Arc settlement using `eth_call` state overrides:

| Direct venue | Input USDC | EURC received by simulated trader |
| --- | ---: | ---: |
| Aero | 1,000 | 878.043448 |
| Archery | 1,000 | 877.831525 |
| Uniswap v4 | 1,000 | 877.680910 |

The helper checks the filled order, exact input debit, output credit and that
settlement buffers did not decrease. This successful full quote-to-settlement
run used **38 free public RPC reads, zero signed/broadcast transactions**.
These are simulated outcomes, not live volume or a deployment claim.

Scope: direct SELL routes; five verified Aero pools, Archery Slipstream tick
spacings 1/10/50, and hookless ERC20/ERC20 v4 pools at four standard fee/tick pairs.
USDC uses Arc's six-decimal ERC20 view; no native-currency wrapping or Permit2
authorization is introduced. V4 funding and swapping must be an exact ordered
two-call bundle bound to one fulfillment. Other protected routes retain their
one-call restriction. Hooks, custom fees, multihop and BUY routing remain with
existing aggregator coverage, where available.

Reproduce after building the backend binaries (requires local solc 0.8.30 and
the existing frontend ethers dependencies):

```sh
node apps/backend/crates/e2e/arc_direct.cjs --live
```

The test starts keyless loopback-only services behind a cached, block-pinned,
read-only public RPC proxy with a 96-request ceiling. It does not start or modify
production services. The smaller independent ABI probe is
`node infra/arc-mainnet/verify_direct.cjs --live` (24-request ceiling).
Offline coverage includes both token directions, golden ABI fixtures,
byte-mutation rejection, bundle ordering, asset accounting, frontend labels and
the all-chain registry invariant. Deployment still requires the reviewed backend
image and normal release activation; deploy the backend before frontend labels.

Address provenance: [Archery's mainnet deployments](https://archery.wtf/docs/security),
[Aero's official Arc announcement](https://aero.xyz/articles/aero-lite-is-live-on-arc/)
and Arc configuration in [its official app](https://app.aero.xyz/), and
[Uniswap's Arc v4 deployments](https://developers.uniswap.org/docs/protocols/v4/deployments#arc-5042).
The exact verified Aero pool list and router constants live in
`apps/backend/crates/shared/src/arc_routes.rs`. Deployment provenance and these
checks are not a third-party audit of the underlying venues.

## Earlier snapshot — September 24

The bounded check was refreshed on September 24 at block **22502232**
(`0x2982b6b2d90eee2d400a08e77604c407db2ccf5f29f9726dcee2b9521da1596e`).
The same direct Uniswap V3 0.05% pool quoted **1,000 USDC → 878.125950 EURC**
and **1,000 EURC → 1,135.664158 USDC**. The state-override router simulation
completed both legs and returned **999.000470 USDC**. This refresh used **21
free public RPC requests**, zero transactions and zero QuickNode/dRPC credits.
The 0.01% Uniswap tier and Synthra still did not produce executable quotes;
AchSwap quotes remained uncompetitive. Only direct Uniswap V3 0.05% is enabled
in the release candidate. This is read-only simulation, not a funded live swap.

## Earlier snapshot — September 22

Read-only checks against Arc's official public RPC, chain 5042, block **22231320**
(`0x3b1390c030421e5e9fac80e5691e52109b454770d33c8b1ccaa373638fc8a523`),
2026-09-22 20:07:35 UTC. All pool lookups, quotes and simulations used that canonical
block hash. This is a snapshot, not a promise of future execution or liquidity.

| Direct venue / fee | 1,000 USDC buys (EURC) | 1,000 EURC buys (USDC) | Router simulation |
| --- | ---: | ---: | --- |
| Uniswap V3 / 0.05% | 873.485656 | 1,143.282334 | Passed both directions |
| Uniswap V3 / 0.01% | Quote reverted | Quote reverted | Not attempted |
| Synthra / 0.01% | No pool | No pool | Not attempted |
| Synthra / 0.05% | Quote reverted | Quote reverted | Not attempted |
| AchSwap / 0.01% | 2.639943 | 3.029391 | Passed, uncompetitive quote |
| AchSwap / 0.05% | 0.393087 | 0.452368 | Passed, uncompetitive quote |

The working Uniswap pool is `0x6fd5f2fb831940dcd61a98c5b3acb7d8c6f3bfc1`.
At that snapshot the direct solver queried only its 500 fee tier: at most four requests per
uncached search (chain ID, block header, factory lookup, quote), plus independent
simulation/backend reads. The initial production candidate is this direct route,
with KyberSwap optional. Synthra and AchSwap remain local regression fixtures;
these results do not justify enabling them in a production service.

The simulation installed `ReadOnlyV3Probe` temporarily through `eth_call` state
override, with a virtual USDC balance. It approved the pinned router, bought EURC,
then sold the received EURC back. Both legs checked actual token balance changes
and exact input consumption. Uniswap returned 999.000333 USDC after the round trip.
No contract was deployed, no funds were transferred onchain, and no transaction
was broadcast. This proves router execution under the simulated conditions;
it does not replace testing an eventual Ophis mainnet deployment.

One separate KyberSwap API quote for 1,000 USDC returned 873.585464 EURC, split
between Uniswap V3 (38.9167%) and hookless Uniswap V4 (61.0833%). That quote was
not block-synchronous with the direct checks and its calldata was not simulated
here. It identifies additional V4 liquidity worth connecting later; it is not
a controlled best-price comparison. The existing direct V4 adapter still assumes
native ETH/WETH and is not enabled for Arc.

## Reproduce deliberately

First run the offline lab to build and test the simulation helper, then:

```sh
python3 infra/arc-mainnet/verify_live.py --live
```

The verifier has a fixed 32-request ceiling, no retries, no polling, no signing,
and accepts only chain/header/call RPC methods. It uses the public Arc endpoint,
not the private QuickNode URL or dRPC. Results go to ignored
`local/generated/live-verification.json`. This run used **21 RPC requests**;
three preliminary public RPC attempts (one HTTP 403) and one KyberSwap HTTP quote
were additional. **QuickNode credits used: 0. dRPC requests: 0.**

Sources: [Arc's public RPC configuration](https://docs.arc.io/arc/references/connect-to-arc),
[Uniswap deployment records](https://developers.uniswap.org/deployments.json),
[Synthra contracts](https://docs.synthra.org/docs/contract-addresses),
[AchSwap contracts](https://docs.achswap.app/technical/contract-addresses/),
[KyberSwap Arc router](https://docs.kyberswap.com/developer-guide/aggregator-api/contracts).
