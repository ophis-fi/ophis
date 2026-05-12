# Greg Phase 3 — Validation Log

> Phase-gate evidence for Stage-1 (testnet) deployments. Stage-2 (mainnet)
> is **deferred to launch-moment** per Clement's 2026-05-04 decision and
> will be appended once executed.

## Scope

Greg runs an unmodified `GPv2Settlement` + `GPv2VaultRelayer` (CoW Protocol's
audited bytecode) under a Greg-controlled `GPv2AllowListAuthentication`. This
log records the testnet deployments executed during Phase 3 and the
end-to-end signals proving each stack is solver-routable.

Phase 3 grew beyond MegaETH-only as the plan progressed: the proof of
"sovereign on chains CoW hasn't deployed to" is most powerful when the same
code lands on multiple chains under the same canonical address. **All four
testnets below run Greg's stack at the same Greg-owned addresses**, which is
itself the proof — CREATE2 determinism + a constant SALT + the same Greg
deployer EOA = identical addresses on every chain.

Mantle and Katana were attempted and shelved (no public testnet faucet
reach during Phase 3); Hyperliquid HyperEVM is in maintenance pause until
brand work resumes.

## Canonical Greg addresses (live on every Greg-target chain)

| Contract | Address |
|---|---|
| `GPv2Settlement` | `0x0864b65F1EFe752a699d119Ae0419E7331a8Bfce` |
| `GPv2VaultRelayer` | `0x842F655C9310C32e5932A0eBFa80c4Cd358c0205` |
| `GPv2AllowListAuthentication` (proxy) | `0x9eFDcC2770Af6837B285702d386D558BD1066BA8` |
| `GPv2AllowListAuthentication` (impl) | `0xFAB54856B6731BC0C32904BE5297A627d9FDFA31` |

**Owner / manager** (allowlist authority): `$OPHIS_MEGAETH_DEPLOYER_ADDRESS`
(Keychain `greg-megaeth-deployer`). Stage-2 transfers ownership to the
existing Phase-2.5 Gnosis Safe `0x858f0F5e…CeF8` after mainnet deploy.

## Stage-1 testnet deployments

### MegaETH testnet (chainId `6343`)

- **RPC:** `https://carrot.megaeth.com/rpc` (the live testnet; chainId 6342 is the deprecated predecessor)
- **Settlement deploy tx:** `0xe2bca2200cb5ad0301372a51fd1443dd927960c090f1a47cf495e4627b769d1a`
- **Auth proxy deploy tx:** `0x3c74e3629eef8b85c09fe7a96f26fdef66d4c8846b88757279205686062ca638`
- **Helpers:** Balances `0x7c2461066e6af18520384ecfb5afdd7209ea9be7`, Signatures `0xf9cc3c9982d8ad424fa8071f09f3fa3072bc03a1`, HooksTrampoline `0x0e9ca200bbc926e2023c856841111feed2818b29`
- **Native token:** `0x4200000000000000000000000000000000000006` (OP-Stack-style WETH9 redeploy)
- **DEX:** Greg-deployed Uniswap V2 fork (Factory + Router02), seeded WETH/USDT0 pool
- **e2e signal:** Stack solves quotes, simulates settlement, autopilot drives. Sequencer rejects EIP-1559 settle txs (upstream bug — `Cannot read properties of undefined (reading 'length')`); pre-mempool flow validated end-to-end.
- **Gas note:** MegaETH accounting is ~45× standard EVM. Deploy required 100M proxy / 250M settlement gas (vs default 25M / 28M).

### HyperEVM testnet (chainId `998`)

- **RPC:** `https://rpc.hyperliquid-testnet.xyz/evm`
- **Settlement deploy tx:** `0x4102af8b0efeb0470f526ec74fa1125c0dbfa158a4c4ff437ea6dcf571104b7c`
- **Auth proxy deploy tx:** `0xc224e44b57d7fa515129db6d2dc8a47876b9ca31963bd309801127a6b72a2f3c`
- **Helpers:** Balances `0x13f618796e8c8626168340558453ebda02add1ff`, Signatures `0x764fe4aa1ff493cf39931c7923c8ff5837596504`, HooksTrampoline `0xe4137bd2ecfdfb96d80629ec254dadec71bc498c`
- **Native token:** WHYPE `0x5555555555555555555555555555555555555555`
- **DEX:** Greg-deployed Uniswap V2 fork
- **HyperCore opt-in:** deployer EOA registered via `evmUserModify` signed action (big-block opt-in is mandatory — settlement deploy ~5M gas exceeds the 3M small-block cap)
- **e2e signal:** quote path green. Settlement simulation blocked by RPC: `eth_call` lacks state-override support (`-32601 Method not found`). Mempool path untested; documented as known testnet-only constraint, not present on mainnet.
- **Status:** **paused** — resumes after brand/domain work per Clement 2026-05-04.

### Optimism Sepolia (chainId `11155420`)

- **RPC:** `https://sepolia.optimism.io`
- **Settlement deploy tx:** `0x13c59083be97725212de24f4bae8c15326b5b9a256ff505bfeeadef064d9ca63`
- **Auth proxy deploy tx:** `0x5fe99bf22c6e1b027893b515adfa2003c296e7f4da3071296c5b5820c4e54951`
- **Helpers:** Balances `0x13f618796e8c8626168340558453ebda02add1ff`, Signatures `0x764fe4aa1ff493cf39931c7923c8ff5837596504`, HooksTrampoline `0xe4137bd2ecfdfb96d80629ec254dadec71bc498c`
- **Native token:** WETH `0x4200000000000000000000000000000000000006` (OP-Stack canonical predeploy)
- **DEX:** Greg-deployed Uniswap V2 fork
- **e2e signal:** quotes + settlement-simulation green; OP rollup is the most production-like of the four testnets.
- **Operational note:** initial deploy hit a transient `replacement underpriced` + null-response from the public RPC. Cleared `.pendingTransactions` and retried; succeeded.

### Linea Sepolia (chainId `59141`)

- **RPC:** `https://rpc.sepolia.linea.build`
- **Settlement deploy tx:** `0xfab4aa63537335060d6718d04644cb19d23e66d80cd9ba6306796cd8a0921b08`
- **Auth proxy deploy tx:** `0x117ddf7852654234c42ad24dd0946b80f9eaa44f0cdd6db1f8af694e190958d9`
- **Helpers:** Balances `0xf9cc3c9982d8ad424fa8071f09f3fa3072bc03a1`, Signatures `0xe3d494a299f35c00668047c5ae2117470c413f5c`, HooksTrampoline `0x0e9ca200bbc926e2023c856841111feed2818b29`
- **Native token (surrogate):** GTETH `0x89bd2e1756ef0c73a425b0387f3a43b3b83bf755` — Linea has no canonical WETH9 predeploy on chain 59141; the in-stack bytecode-deploy attempt failed on truncated bytecode, so Greg uses GTETH (a deployed test ERC20) as the native-token surrogate. The pool is GTETH/GTUSD instead of WETH/GTUSD.
- **DEX:** Greg-deployed Uniswap V2 fork
- **e2e signal:** quote path green; pool seeded; settlement simulation green.
- **Gas note:** Linea enforces a ~15M per-tx gas cap on Sepolia. Deploy tuned to `OPHIS_AUTH_PROXY_GAS_LIMIT=12000000` and `OPHIS_SETTLEMENT_GAS_LIMIT=14000000`. 20M was rejected; 15M accepted.

## Stage-2 (mainnet) — deferred

Per Clement's 2026-05-04 re-sequencing: MegaETH mainnet (and the rest of
the mainnet roll-out) is deferred to the **launch moment** — after brand,
domain, an Aleph-hosted backend, the Phase-4 independence move (running
Greg's own orderbook on the existing 10 CoW chains so the product no
longer depends on `api.cow.fi`), and a public retail surface are all in
place. Stage-2 deploy + first-swap evidence will be appended here when
that gate is reached.

## Cross-cutting patches landed in Phase 3

The `apps/backend/` Rust workspace is a vendored CoW Protocol fork; every
new chain required the same shape of patch:

1. `apps/backend/crates/chain/src/lib.rs` — add the chain to the `Chain` enum (id, name, native-amount, block-time, `TryFrom<u64>` arm).
2. `apps/backend/crates/liquidity-sources/src/lib.rs` — empty `BaselineSource` set for Greg-deployed chains (no upstream-blessed liquidity sources to enumerate).
3. `apps/backend/crates/price-estimation/src/native/coingecko.rs` — bail for the chain (no CoinGecko index). Native-price is sourced from the in-stack baseline solver against the V2 pools we seed.

The Hardhat config at `contracts/hardhat-megaeth.config.ts` (named for
historical reasons; serves all Greg-target chains) overrides
`namedAccounts.{owner,manager}` to the Greg deployer EOA on every Greg
network. **This is the load-bearing piece for canonical addresses across
chains:** without the override, `hardhat-deploy` defaults to the canonical
CoW EOA `0x6Fb5916c…` and the proxy lands at the canonical CoW address —
which would put control of our deploy in CoW's keyholder's hands. With
the override, the same Greg deployer signs everything → identical CREATE2
addresses on every Greg-target chain → CoW key-holders cannot interact
with Greg deployments at all.

## Phase-3 close-out artefacts in this commit chain

- `b123139bf` — record OP Sepolia + Linea Sepolia deployment artefacts in `contracts/networks.json`
- `558104c76` — Linea Sepolia deploy on chain 59141
- `9c21dd063` — OP Sepolia deploy on chain 11155420
- `62513d533` — HyperEVM testnet deploy on chain 998
- `2d884ade8` — MegaETH testnet end-to-end (V2 fork + simulation green)

(Predecessor commits: `b3b6b7846` Stage-1 ABI smoke; `27fe55dc5` configs
register MegaETH in the upstream chain enum; `4e8397b2a` testnet
docker-compose.)

Tag `v0.3-phase3` is reserved for Clement to apply when the close-out
checklist is signed off.

## Update — 2026-05-11 (Spec 1 backend revival)

Two changes since the original 2026-05-04 Phase 3 validation:

- **Linea Sepolia dropped.** CoW Protocol serves Linea mainnet natively
  via `api.cow.fi/linea` (chainId 59144 in `COW_SUPPORTED_CHAIN_IDS`). Our
  Linea Sepolia stack was always validation-only — the `infra/linea/`
  directory and the `LineaSepolia` Rust enum variant have been removed
  from the tree. Pools and contracts on Linea Sepolia are abandoned in
  place.

- **VM migration.** The Phase 3 hosting VM at `REDACTED_ORIGIN_IP_OLD:24019` is
  dead (TCP connection refused, instance presumed reclaimed by Aleph).
  Spec 1 revives the multi-chain backend by co-tenanting the
  optimism-sepolia and megaeth-testnet stacks onto the existing rebates
  VM at `vm4.alephvision.eu` (`REDACTED_ORIGIN_IP:24014`). Same SSH context as
  the rebate-indexer; chains exposed via per-chain named Cloudflare
  Tunnels (`optimism-sepolia.ophis.fi`, `megaeth-testnet.ophis.fi`)
  instead of the rotating `*.trycloudflare.com` quick-tunnels Phase 3 used.

- **Testnet contracts are unchanged.** CREATE2-deterministic deployment
  means Greg's `GPv2Settlement` at `0x0864b65F1EFe752a699d119Ae0419E7331a8Bfce`
  still resolves on Optimism Sepolia and MegaETH testnet — verified
  via `cast code` 2026-05-11.

Spec doc: `docs/development/specs/2026-05-11-spec-1-backend-revival.md`.
