# Native settlement adapter migration

The three adapter implementations now call `sync(address(0))` immediately
before native settlement. Existing immutable deployments retain their old
behavior; publishing the source does not update them.

The following are **planned v2 addresses**, derived offline, not deployment
receipts. They cover the four lanes configured in the repository. Presence
and activation of each v1 deployment must be checked on its chain.

| Chain | Adapter | Previous configured address | Planned v2 address |
| --- | --- | --- | --- |
| Optimism (10) | OphisHooklessUniswapV4Adapter | `0xd882da9CB91EB458337413E5846824CDCADB2Ddc` | `0x833fA253e3A0cb2be15F14Cb0B0Ad0C17dD57b12` |
| Unichain (130) | OphisHooklessUniswapV4Adapter | `0x4C41eC6850300d2D6Ba65d602fd31eC07F255b2C` | `0xe490d7aC34CDf92a3Bd16cd4cA3BB1F1a6671828` |
| Robinhood (4663) | OphisUniswapV4Adapter | `0x8573C5Fcf5BD890f4EDD4a41e783Eac552B307ae` | `0xb0F223B932B6C2a5CB6e3a6B04AAB82b44eA7C29` |
| Robinhood (4663) | OphisFablesAdapter | `0xa0C33928831cB4518b8c4A7BE6c0f98BA8A22de5` | `0xC35FE0dBABd82f9E347CF6a7d9c795A18c902FbE` |

## Generate the unsigned transactions

From `contracts/`, with its frozen Yarn dependencies and forge-std installed:

```sh
FOUNDRY_PROFILE=direct-routes forge build
node script/native-settlement-migration.cjs > /tmp/native-settlement-migration.json
```

The generator does not connect to an RPC or send a transaction. It emits the
chain, CREATE2 proxy, zero value, complete calldata, constructor arguments,
salt, initcode hash and expected address for each route. It rejects stale
source artifacts or a build producing a different reviewed address.

All v2 artifacts use solc `0.8.30+commit.73712a01`, Cancun, optimizer enabled
with 1,000,000 runs, no via-IR, and the committed explicit forge-std remapping.
The proxy is `0x4e59b44847b379578588920cA78FbF26c0B4956C`. The new salt labels
are `ophis.optimism.hookless-v4.v2`, `ophis.unichain.hookless-v4.v2`,
`ophis.robinhood.hookless-v4.v2` and `ophis.robinhood.fables.v2`.
The four addresses were independently reproduced with `cast create2` using
the emitted salt and initcode hash.

The existing Optimism and Robinhood browser ceremonies identify deployment
wallet `0x0494f503912c101bfd76b88e4f5d8a33de284d1a`. Use the intended deployer
wallet or hardware signer for the selected chain; a driver operational key
is unnecessary. CREATE2 does not depend on the transaction sender here.
Do not reuse the old browser artifact or `DeployDirectAdapters.s.sol`:
their v1 artifact hashes and addresses refer to the previous source, and
the existing direct-routes script deliberately rejects the changed hash.

## Deploy, verify, then activate

For each chain, verify the chain ID and CREATE2 proxy runtime, check whether
the planned address already contains code, and estimate the selected
unsigned transaction with the intended funded deployer. Review and sign
that exact zero-value payload using the wallet. Record its successful
receipt before changing any live configuration. If code already exists,
verify it against this source and constructor arguments before reuse.

Verify published source/compiler settings, deployed runtime and immutable
getters (`settlement`, `poolManager`, `weth`, and `quoteToken` or `usdg`;
also `poolFee` and `tickSpacing` for the generic hookless adapter).

After receipts and code verification, replace the relevant old addresses
in the following locations together, rebuild the backend, and render the
chain configuration using the existing `compose-up.sh` release process:

- `apps/backend/crates/driver/src/domain/competition/solution/custom_allowlist.rs`
- `apps/backend/crates/driver/src/infra/solver/dto/solution.rs`
- `apps/backend/crates/solvers/src/infra/config/dex/uniswap_v4/file.rs`
- `apps/backend/crates/solvers/config/example.uniswap-v4.toml`
- `infra/optimism-mainnet/configs/uniswap-v4.toml.tmpl`
- `infra/unichain-mainnet/configs/uniswap-v4.toml.tmpl`
- `infra/robinhood-mainnet/configs/uniswap-v4.toml.tmpl`
- `infra/robinhood-mainnet/configs/fables.toml.tmpl`

Update deployment documentation, browser ceremonies and their pinned
artifacts to the verified release; retire or repin the old direct-routes
script. Historical blog references are not an activation mechanism.
Check solver health, quote generation and driver simulation against the
new address on each enabled lane before enabling settlement traffic.
These adapters require no administrator migration or solver registration.
Source changes and an unsigned payload alone leave the live v1 lanes
unremediated.
