# Direct DEX routes

Implemented configuration; production rollout is still required.

| Chain | Direct venue | Coverage |
| --- | --- | --- |
| Unichain | Uniswap V4 | Hookless ETH/USDC, fee 500, spacing 10 |
| Unichain | Velodrome V2 | Stable/volatile pools; direct or through WETH |
| Optimism | Velodrome V2 | Stable/volatile pools; direct or through WETH |
| Optimism | Velodrome Slipstream | Single pool across pinned tick spacings |
| Robinhood | Fables | Dynamic-fee ETH/USDG pool with the pinned Fables hook |
| Robinhood | RamsesX | V3 single pool across pinned tick spacings |
| Robinhood | UP33 | Existing V2 lane retained and fork-tested |
| Robinhood | PancakeSwap | V3 single pool across pinned fee tiers |

All these routes support exact-input SELL orders. V3 multihop and other pool
families are outside this implementation. Native assets use the existing
settlement wrapping path. Quotes use chain-bound read-only RPC; execution
passes strict output simulation and chain-specific calldata validation.

Curve on Unichain is excluded: the official SDK has no chain 130 configuration
and its pool API rejects `unichain`. No deployment was supplied by the requester.
Beefy vaults are yield strategies, not an additional swap venue; the Optimism
Velodrome routes access their underlying DEX liquidity where applicable.

## Provenance

- [Uniswap V4 deployments](https://developers.uniswap.org/docs/protocols/v4/deployments)
- [Velodrome V2](https://github.com/velodrome-finance/contracts/blob/main/README.md)
- [Velodrome Unichain](https://github.com/velodrome-finance/superchain-contracts/blob/main/deployment-addresses/unichain.json)
- [Velodrome Slipstream](https://github.com/velodrome-finance/slipstream/blob/main/README.md)
- [PancakeSwap V3](https://developer.pancakeswap.finance/contracts/v3/addresses)
- [Ramses contract addresses](https://www.ramses.xyz/docs/raw/contract-addresses.md)
- [Fables application and contract documentation](https://www.fables.fi/)
- [Curve network configuration](https://github.com/curvefi/curve-js/blob/master/src/constants/network_constants.ts)
- [Beefy vaults](https://docs.beefy.finance/beefy-products/vaults)

## Adapter deployment and rollout

| Chain | Adapter | Deterministic address |
| --- | --- | --- |
| Unichain | OphisHooklessUniswapV4Adapter | `0x4C41eC6850300d2D6Ba65d602fd31eC07F255b2C` |
| Robinhood | OphisFablesAdapter | `0xa0C33928831cB4518b8c4A7BE6c0f98BA8A22de5` |

Both CREATE2 deployments were dry-run successfully. Neither was broadcast.
The script checks chain, initcode hash, deterministic address and proxy code.
Compiler settings and source metadata affect these addresses: use the committed
Foundry profile and do not repin addresses without repeating review and tests.

From the repository root, dry-run each chain:

```sh
FOUNDRY_PROFILE=direct-routes forge script contracts/test/direct-routes/DeployDirectAdapters.s.sol:DeployDirectAdapters --root contracts --rpc-url "$UNICHAIN_RPC"
FOUNDRY_PROFILE=direct-routes forge script contracts/test/direct-routes/DeployDirectAdapters.s.sol:DeployDirectAdapters --root contracts --rpc-url "$ROBINHOOD_RPC"
```

Broadcast requires an explicitly selected funded signer and `--broadcast`.
After verifying both deployed contracts, build the backend image containing
the solver and driver changes. Roll out each chain using its existing
`compose-up.sh`, which renders configs and restarts the dependent services.
Check the new solver health endpoints, quotes and driver simulation before
checking a small settlement. Existing aggregator lanes remain available.

## Reproducible checks

```sh
cargo +1.96.1 test --manifest-path apps/backend/Cargo.toml -p driver custom_allowlist --lib --locked --offline
cargo +1.96.1 test --manifest-path apps/backend/Cargo.toml -p solvers infra::dex:: --lib --locked --offline
# Set OP_MAINNET_RPC, UNICHAIN_RPC and ROBINHOOD_RPC for read-only network checks:
cargo +1.96.1 test --manifest-path apps/backend/Cargo.toml -p solvers live_direct_routes --lib --locked --offline -- --ignored --nocapture
FOUNDRY_PROFILE=direct-routes forge test --root contracts -vv
```

The fork tests exercise actual router swaps for all six V2/V3 venue variants
and both directions of the two V4 adapters, plus authorization and output-floor
checks. Public RPC rate limits may require retrying a failed fork fetch.
