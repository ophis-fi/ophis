# f(x) direct liquidity, checked 20 October 2026

The local change adds direct exact-input SELL swaps through 16 published
Ethereum fxUSD Curve StableSwap-NG pools. It reuses Ophis's existing `curve`
solver and driver validation; it does not add another aggregator or service.
The most liquid published pool at discovery was USDC/fxUSD, with approximately
$9.09 million reported by Curve. Several other published pools contain less
than $100; discovery does not imply useful depth for a user's trade.

## Included pools

Addresses below are **LP/pool** addresses, not reward gauge addresses. They
were matched from the [official f(x) contract list](https://fxprotocol.gitbook.io/fx-docs/more/resources/contracts)
to [Curve's StableSwap-NG registry API](https://api.curve.finance/v1/getPools/ethereum/factory-stable-ng),
then their ordered `coins()` were checked onchain. Values are a dated discovery
snapshot, not quote guarantees or independently valued TVL.

| Pair | Ethereum pool | Curve-reported USD snapshot |
| --- | --- | ---: |
| crvUSD/fxUSD | `0x8fFC7b89412eFD0D17EDEa2018F6634eA4C2FCb2` | $33 |
| pyUSD/fxUSD | `0xd6982da59F1D26476E259559508f4135135cf9b8` | $328 |
| Dola/fxUSD | `0x189B4e49B5cAf33565095097b4B960F14032C7D0` | $972 |
| Grai/fxUSD | `0x69Cf42F15F9325986154b61A013da6E8feC82CCF` | $0 |
| Frax/fxUSD | `0x1EE81c56e42EC34039D993d12410d437DdeA341E` | $25 |
| GHO/fxUSD | `0x74345504Eaea3D9408fC69Ae7EB2d14095643c5b` | $133,329 |
| eUSD/fxUSD | `0x16b54e3aC8e3ba088333985035b869847e36E770` | $41,604 |
| mkUSD/fxUSD | `0xcA554E2e2948a211D4650Fe0F4E271f01f9cB5F1` | $523 |
| ULTRA/fxUSD | `0xF33aB11E5C4e55DAcB13644f0C0A9d1e199A796F` | $20 |
| rev fxUSD | `0x6fC7eA6CA8Cd2759803eb78159C931a8FF5E0557` | $17 |
| fxUSD/rUSD | `0x2116BFaD62b383043230501f6a124c6EA60CcfA5` | $48 |
| alUSD/fxUSD | `0x27cB9629aE3Ee05cb266B99cA4124EC999303c9D` | $151,602 |
| MIM/fxUSD | `0xD7Bf9bb6Bd088317Effd116E2B70ea3A054cBceb` | $1 |
| zunUSD/fxUSD | `0x13eA95Ce68185e334d3747539845A3b7643a8cab` | $20 |
| USDC/fxUSD | `0x5018BE882DccE5E3F2f3B0913AE2096B9b3fB61f` | $9,093,994 |
| USD0/FXUSD | `0x74c204520c9e88aA3EB9d61788ABA11Be1e0193F` | $31 |

## Local execution

The catalog is in `apps/backend/crates/shared/src/fx_curve.rs`. The solver
accepts only pinned pool/coin combinations, rejects mixed Ethereum/Optimism
configuration, authenticates the RPC chain ID and coin indices at startup,
and quotes the pool's `get_dy(int128,int128,uint256)` directly. Calls use
`exchange(int128,int128,uint256,uint256)`; output returns to Settlement, the
caller. There is no third-party recipient, arbitrary converter or external
route blob.

The driver binds the exact pool, coin indices, input, minimum output and
allowance to one fulfilled order. It rejects raw pre/post calls, extra
interactions, unrelated tokens, zero amounts, excess allowances and native
value. Strict output simulation is mandatory and internalization is disabled.
The existing Optimism 3pool remains supported. Exact-output BUY orders are
unsupported by this lane.

`apps/backend/crates/solvers/config/example.fx-curve.toml` is a complete local
example using Ethereum's CoW Settlement. From `apps/backend`, an existing
solver binary can be run with:

```sh
solvers --addr 127.0.0.1:7872 curve --config crates/solvers/config/example.fx-curve.toml
```

Ophis currently uses **CoW-hosted Ethereum auctions**. The local example and
local driver guards do not enroll a solver into those auctions. Serving users
requires CoW solver onboarding, appropriate settlement authorization and the
hosted infrastructure's acceptance/simulation of these pool interactions.
No deployment, registration or funded transaction was performed. See the
[follow-up audit](../audits/2026-10-20-liquidity-addons-review.md) for the final
settlement checks and their scope.

## Protocol distinctions

The current app includes leverage, savings and stability products. These are
not interchangeable with the Curve spot pools:

- [V2 deployments](https://github.com/AladdinDAO/fx-protocol-contracts/blob/main/ignition/deployments/ethereum/deployed_addresses.json)
  publish fxUSD `0x085780639CC2cACd35E474e71f4d000e2405d8f6`,
  fxSP/FxUSDBasePool `0x65C9A641afCEB9C0E6034e558A319488FA0FA3be`,
  PoolManager `0x250893CA4Ba5d05626C785e8da758026928FCD24` and
  RouterDiamond `0x33636D49FbefBE798e15e7F356E8DBef543CC708`.
- [V2 collateral redemption](https://fxprotocol.gitbook.io/fx-docs/risk-management/advanced-peg-protection-mechanisms/understanding-the-redemption-mechanism)
  is a last-resort peg mechanism, gated on depeg conditions and charging a
  redemption fee. It is not always-available spot liquidity.
- [fxSAVE integration](https://fxprotocol.gitbook.io/fx-docs/developers/integrating-fxsave)
  describes withdrawal steps/cooldown and an atomic instant-redemption path
  that charges a withdrawal fee. A savings adapter must quote that fee, share
  conversion, both returned assets and the converter before exposing a route.
- Ophis already has a legacy `fx` redemption solver using `getMarkets()` and
  `redeem(baseToken,amount,receiver,minOut)`. That is a different interface
  from the V2 PoolManager mechanism. This change does not relabel it as V2 or
  enable it as a permanent 1:1 route.
- Published FXN/ETH and FXN derivatives use different Curve pool types. Their
  ABIs and pricing need separate adapters; they are outside this stable-pool
  extension. The app's yield figures are not used as executable swap quotes.

## Validation and limits

Two Foundry tests passed at Ethereum block **26,232,714**: all 16 pools swapped
in both directions from the real CoW Settlement address with an EOA origin
(32 executions), and an impossible minimum output reverted without spending
Settlement's input. Tests compare actual balance deltas with the pool's
reported output and preserve an input buffer. Local fork balance seeding is
a test fixture, not evidence of user funds being available.

The actual Rust connector authenticated all 16 pools and returned 32 live
quotes using correct token units (USDC and PYUSD have six decimals). Seven
non-live Curve solver/driver tests, 39 driver interaction-guard tests and six
protected-fulfillment tests passed. Config checks matched all 16 official LP
addresses and ordered API coins. No full application build or end-to-end
GPv2 auction was run; fork replay needs archive access to the pinned block.

Claude reviewed the implementation and Jev checked source claims. Their raw
results, primary source snapshots and execution logs are in
`/Users/scep/ophis-addon-evidence/02-fx/`. The first Jev pool-list check had an
incomplete line range; the corrected check includes the whole published pool
table. Source matching and live/fork execution remain the substantive checks.
