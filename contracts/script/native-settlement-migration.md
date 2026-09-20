# Native settlement adapter migration

The three adapter implementations now call `sync(address(0))` immediately
before native settlement. Existing immutable deployments retain their old
behavior; publishing the source does not update them.

All four v2 adapters were deployed on 2026-09-20 UTC using Ledger account
`0xBeC5B03ffDcac50071693E87bFDb88bAa6710199`. Receipts, exact calldata,
runtime (including consistent immutable references) and every constructor
getter were independently checked against the reviewed build.

| Chain | Adapter | Previous configured address | Deployed v2 address |
| ---------------- | ----------------------------- | -------------------------------------------- | -------------------------------------------- |
| Optimism (10) | OphisHooklessUniswapV4Adapter | `0xd882da9CB91EB458337413E5846824CDCADB2Ddc` | `0x833fA253e3A0cb2be15F14Cb0B0Ad0C17dD57b12` |
| Unichain (130) | OphisHooklessUniswapV4Adapter | `0x4C41eC6850300d2D6Ba65d602fd31eC07F255b2C` | `0xe490d7aC34CDf92a3Bd16cd4cA3BB1F1a6671828` |
| Robinhood (4663) | OphisUniswapV4Adapter | `0x8573C5Fcf5BD890f4EDD4a41e783Eac552B307ae` | `0xb0F223B932B6C2a5CB6e3a6B04AAB82b44eA7C29` |
| Robinhood (4663) | OphisFablesAdapter | `0xa0C33928831cB4518b8c4A7BE6c0f98BA8A22de5` | `0xC35FE0dBABd82f9E347CF6a7d9c795A18c902FbE` |

Deployment receipts: [Optimism](https://optimistic.etherscan.io/tx/0x1baaedba8f67f47f416ea59652412e8c2b5d104de6658a70ac8fa889ed6ab56a),
[Unichain](https://uniscan.xyz/tx/0x683573bb0e8001e2bdf6085ac57dd1de674f492b17a2ac4dfab08954012c25ea),
[Robinhood Uniswap V4](https://robinhoodchain.blockscout.com/tx/0xd04966770847612a06d5ffda4bf9dffbe0a90e35e9df65f122409e70e8426d9d),
[Robinhood Fables](https://robinhoodchain.blockscout.com/tx/0x3be23bee22107944a463a0d7aefea8e6ef5ec9521b7da22445ce98567c92349b).
Do not resubmit these transactions. Backend activation requires the coordinated
configuration rollout below; an on-chain deployment alone does not activate a lane.

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

CREATE2 does not depend on the transaction sender here; a driver operational
key is unnecessary. The direct-routes script now pins the deployed v2 builds.
The one-time browser ceremonies are retired; historical v1 artifacts must not
be used to reproduce these v2 addresses.

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
