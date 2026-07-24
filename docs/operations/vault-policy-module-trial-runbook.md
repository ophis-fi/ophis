# Vault policy module — live trial runbook (OP, Base, Ethereum, Arbitrum)

How to stand up a gated Phase-B vault-curator trial on a new chain: deploy the
`OphisVaultPolicyModule`, migrate/point a trial Safe at it, and settle a real
USDC to WETH rebalance through Ophis. This mirrors the Unichain trial (R2) and
assumes the module + factory are already on `main`.

The module gates CoW presign so a compromised curator key cannot drain the
Safe: it pins receiver == Safe, a token allowlist, a Chainlink oracle floor,
the Ophis partner-fee appData, and a rolling USD turnover cap. The curator is a
DIRECT caller (a dedicated EOA / MPC / multisig) that may call ONLY
`rebalance` / `cancel` — never a Safe owner and never an enabled Safe module
(the constructor + factory reject both).

## Verified per-chain config

Every address below is checked against live chain state by the fork preflight
(`contracts/test/fork/VaultPolicyModule{OP,Base}Real.t.sol`) — the module
constructor probes each feed + settlement, so a passing preflight IS the proof.

| | Optimism (10) | Base (8453) | Ethereum (1) | Arbitrum (42161) |
|---|---|---|---|---|
| Settlement | `0x310784c7FCE12d578dA6f53460777bAc9718B859` (Ophis self-hosted) | `0x9008D19f58AAbD9eD0D60971565AA8510560ab41` (canonical) | canonical (same) | canonical (same) |
| Relayer (read from settlement) | `0x83847EaB41ad9ea43809ce71569eB2e9daF51830` | `0xC92E8bdf79f0507f65a392b0ab4667716BFE0110` | canonical (same) | canonical (same) |
| USDC (6dp) | `0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85` | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` | `0xaf88d065e77c8cC2239327C5EDb3A432268e5831` |
| WETH (18dp) | `0x4200000000000000000000000000000000000006` | `0x4200000000000000000000000000000000000006` | `0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2` | `0x82aF49447D8a07e3bd95BD0d56f35241523fBab1` |
| ETH/USD feed (8dp) | `0x13e3Ee699D1909E989722E753853AE30b17e08c5` | `0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70` | `0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419` | `0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612` |
| USDC/USD feed (8dp) | `0x16a9FA2FDa030272Ce99B29CF780dFA30361E0f3` | `0x7e860098F58bBFC8648a4311b374B1D669a2bc6B` | `0x8fFfFfd4AfB6115b954Bd326cbe7B4BA576818f6` | `0x50834F3163758fcC1Df9973b6e91f0F0F0434aD3` |
| Sequencer uptime | `0x371EAD81c9102C9BF4874A9075FFFf170F2Ee389` | `0xBCF85224fc0756B9Fa45aA7892530B47e10b6433` | none (L1: gate disabled) | `0xFdB631F5EE196F0ed6FAa767959853A9F217697D` |
| maxStaleness (WETH / USDC) | 2h / 26h | 2h / 26h | 2h / 26h | 2h / 26h |
| seq grace | 1h | 1h | — | 1h |

OP is self-hosted (Ophis non-canonical settlement + relayer). Base, Ethereum,
and Arbitrum are CoW-hosted: orders settle through the canonical settlement +
relayer with the Ophis partner fee carried in the pinned appData. The module
reads the relayer + domain separator from whichever settlement it is configured
with — the per-chain differences are the address table above, plus: Ethereum is
an L1 (no sequencer feed, gate disabled). Every chain's ETH/USD feed is
deviation-driven and updates every few minutes in practice, so the tight 2h
window applies everywhere; the 26h window is only for the 24h-heartbeat stable
feeds.

### Plasma (9745) — WXPL/USDT0 variant

Plasma does not fit the USDC/WETH matrix above, so it gets its own config.
Plasma is CoW-hosted (canonical settlement + relayer) and an L1 (PlasmaBFT, not
an OP-stack rollup), so — like Ethereum — there is no Chainlink sequencer-uptime
feed and the gate is disabled. Plasma has no USDC, so the allowlist is the
native pair WXPL (wrapped-native) + USDT0. Both feeds carry a 24h heartbeat, so
the staleness window is 26h on BOTH legs (unlike the 2h volatile leg elsewhere).

| | Plasma (9745) |
|---|---|
| Settlement | `0x9008D19f58AAbD9eD0D60971565AA8510560ab41` (canonical) |
| USDT0 (6dp) | `0xB8CE59FC3717ada4C02eaDF9682A9e934F625ebb` |
| WXPL (18dp) | `0x6100E367285b01F48D07953803A2d8dCA5D19873` |
| USDT0/USD feed (8dp) | `0x3205B49b3C8c5D593589e1e70567993f72C5F845` |
| XPL/USD feed (8dp) | `0xF932477C37715aE6657Ab884414Bd9876FE3f750` |
| Sequencer uptime | none (L1: gate disabled) |
| maxStaleness (WXPL / USDT0) | 26h / 26h |
| seq grace | — |

Status: DEPLOYED + enabled on Plasma mainnet (2026-07-24) — module
`0x905f8fd53D6568C8cd488CdbFFcb3A81fF1DEAf4`, factory
`0x8BfD02f98854647f4235D770A284DDbBAc0bF2Ca`, on the shared trial Safe
`0x4E2b51d89EA315949d27C906fAB1187b88F4e786` (same curator + appData as the other
5 chains). For a new Plasma vault, the rebalance pair is WXPL/USDT0 (a non-stable pair), so keep
`isStablePair = false` and `CHAIN_ID = 9745` when deriving the appData in Step 1,
and fund the trial Safe with USDT0 (not USDC) for the rebalance.

## Prerequisites

- A trial Safe (canonical Safe v1.3.0) on the target chain, owned by you.
- A dedicated curator address (EOA / MPC / multisig) that is NOT a Safe owner
  and NOT an enabled module on that Safe.
- A deployer EOA funded with a little native gas on the target chain.
- Some of the sell token in the trial Safe for the rebalance — USDC on
  OP/Base/Ethereum/Arbitrum, USDT0 on Plasma (10-50 is plenty).

## Step 0 — run the preflight (no funds, verifies the chain config)

```bash
# Run all forge commands from the contracts/ directory (the foundry project root).
cd contracts

# OP
OPHIS_FORK_RPC=https://mainnet.optimism.io \
  forge test --match-path 'test/fork/VaultPolicyModuleOPReal.t.sol' -vv
# Base
OPHIS_FORK_RPC_BASE=https://mainnet.base.org \
  forge test --match-path 'test/fork/VaultPolicyModuleBaseReal.t.sol' -vv
# Ethereum
OPHIS_FORK_RPC_ETH=https://ethereum-rpc.publicnode.com \
  forge test --match-path 'test/fork/VaultPolicyModuleEthereumReal.t.sol' -vv
# Arbitrum
OPHIS_FORK_RPC_ARBITRUM=https://arb1.arbitrum.io/rpc \
  forge test --match-path 'test/fork/VaultPolicyModuleArbitrumReal.t.sol' -vv
# Plasma
OPHIS_FORK_RPC_PLASMA=https://rpc.plasma.to \
  forge test --match-path 'test/fork/VaultPolicyModulePlasmaReal.t.sol' -vv
```

3/3 pass = the feeds, settlement, and tokens are live and the module builds.

## Step 1 — derive the appData hash to pin (per Safe, per chain)

The module accepts only orders carrying one exact appData preimage. Derive its
hash the same way `buildOphisSafePresign` will at rebalance time (chainId +
`signer = the Safe`, no referral, non-stable pair for USDC/WETH):

```js
// node --input-type=module, run from packages/safe-swap after `pnpm build`
import { buildOphisOrderMetadata } from '@ophis/sdk';
import { MetadataApi, stringifyDeterministic } from '@cowprotocol/app-data';
import { keccak256, toBytes } from 'viem';

const CHAIN_ID = 10;           // 1 Ethereum | 10 OP | 8453 Base | 42161 Arbitrum | 9745 Plasma
const SAFE = '0xYourTrialSafe';
const input = buildOphisOrderMetadata({ chainId: CHAIN_ID, signer: SAFE });
const full = await stringifyDeterministic(await new MetadataApi().generateAppDataDoc(input));
console.log('VAULT_APPDATA_HASH =', keccak256(toBytes(full)));
```

Keep the same params (chainId, signer, referralCode, isStablePair) for every
rebalance so the appData — and thus its hash — stays stable.

## Step 2 — deploy the module

```bash
export VAULT_SAFE=0xYourTrialSafe
export VAULT_CURATOR=0xYourCuratorAddress
export VAULT_APPDATA_HASH=0x...        # from Step 1
export VAULT_CAP=250000000000000000000 # 250e18 USD/day; tune to trial size

# From the contracts/ directory (Step 0), so foundry resolves the src/contracts/... imports.
# OP
forge script script/DeployVaultPolicyModuleOP.s.sol \
  --rpc-url https://mainnet.optimism.io --broadcast --account <deployer-keystore>
# Base
forge script script/DeployVaultPolicyModuleBase.s.sol \
  --rpc-url https://mainnet.base.org --broadcast --account <deployer-keystore>
# Ethereum
forge script script/DeployVaultPolicyModuleEthereum.s.sol \
  --rpc-url https://ethereum-rpc.publicnode.com --broadcast --account <deployer-keystore>
# Arbitrum
forge script script/DeployVaultPolicyModuleArbitrum.s.sol \
  --rpc-url https://arb1.arbitrum.io/rpc --broadcast --account <deployer-keystore>
# Plasma (public RPC is rate-limited / "not for production" — prefer the Ophis QuickNode endpoint)
forge script script/DeployVaultPolicyModulePlasma.s.sol \
  --rpc-url https://rpc.plasma.to --broadcast --account <deployer-keystore>
```

Use a foundry keystore (`--account`) or `--ledger` for the deployer — never pass
a raw private key on the command line. The script prints `factory`, `module`,
and `relayer`; record the `module` address. It reverts at deploy if the curator
is a Safe owner or an enabled module, or if any feed is stale/invalid.

## Step 3 — fund the trial Safe

Send the sell token you intend to rebalance (USDC on OP/Base/Ethereum/Arbitrum,
USDT0 on Plasma) to `VAULT_SAFE` (from Step 2's config).

## Step 4 — enable the module on the Safe

In the Safe UI, Transaction Builder → new transaction to the Safe itself:

- To: the Safe address, ETH value: `0`
- Method: `enableModule(address module)` with the deployed `module` address
  (ABI: `enableModule(address)`, selector `0x610b5925`)

Sign + execute with the Safe owners. Confirm `isModuleEnabled(module)` returns
true afterward. (Do NOT enable the curator as a module — the module rejected
that at deploy; enabling it later would defeat the gate.)

## Step 5 — build + execute a rebalance

Use `@ophis/safe-swap` to build the presign, keeping params identical to Step 1:

```js
import { buildOphisSafePresign } from '@ophis/safe-swap';

// Per-chain token addresses (MUST match the deployed module's allowlist - the
// module rejects any other token as TokenNotAllowed). Same values as the table.
const CHAINS = {
  10:    { usdc: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', weth: '0x4200000000000000000000000000000000000006' }, // OP
  8453:  { usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', weth: '0x4200000000000000000000000000000000000006' }, // Base
  1:     { usdc: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', weth: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' }, // Ethereum
  42161: { usdc: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', weth: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1' }, // Arbitrum
  9745:  { usdc: '0xB8CE59FC3717ada4C02eaDF9682A9e934F625ebb', weth: '0x6100E367285b01F48D07953803A2d8dCA5D19873' }, // Plasma (no USDC: usdc slot = USDT0, weth slot = WXPL; both 6dp/18dp)
};

const CHAIN_ID = 10;                        // set to the chain you deployed on
const VAULT_SAFE = process.env.VAULT_SAFE;  // your trial Safe
const { usdc: USDC, weth: WETH } = CHAINS[CHAIN_ID];

const { orderUid, order, txs } = await buildOphisSafePresign({
  chainId: CHAIN_ID, safe: VAULT_SAFE,
  sellToken: USDC, buyToken: WETH,
  sellAmount: '20000000',   // 20 USDC (atomic, 6dp)
  slippageBps: 50,
  // ttlSeconds: 1500,      // optional (>=0.1.1): shorter order; keep maxTtl above it
});
```

Two execution paths:

- Module path (recommended for the trial): the curator calls
  `module.rebalance(order, minBuyOverride)`. The module re-derives the uid,
  re-checks every field against the policy, sets the exact relayer allowance,
  and presigns. This is what the gate is for.
- Direct path: execute `txs` ([approve?, setPreSignature]) straight from the
  Safe. Bypasses the module's per-order checks — use only outside the trial.

Order sizing vs the floor band (learned live on Arbitrum + Ethereum): the
module accepts an order only if its buy floor is within `maxSlippageBps` (50bps)
of the Chainlink mid. The quote's gas-based fee consumes part of that band -
negligible on L2s, but on Ethereum a ~$0.07-0.09 fee is 30-60bps of a $15-20
order, which stacked with the default 50bps order slippage puts the order BELOW
the module floor (revert `BelowFloor`, fail-closed, nothing signed). Rules of
thumb: keep `order slippageBps + fee-as-bps-of-order + quote-vs-oracle gap <
50bps`; on L1 size orders so the fee is <15bps (>= ~$60 at typical fees), or
tighten `slippageBps` (30bps worked on Arbitrum, 3bps cleared a $19 L1 order);
real vault rebalances ($10k+) never feel this - it is a small-trial artifact.

TTL: `buildOphisSafePresign` defaults to an 1800s order TTL (validTo = build-time
wall clock + 1800) and accepts an optional `ttlSeconds` (>= 0.1.1, capped at
3600). The module here is deployed with `maxTtl = 1980` (Step 2): the builder's
1800s order plus 180s of block-timestamp-lag margin, kept tight so a compromised
curator cannot stretch the fill window beyond ~33 minutes (audit lead). It gives the
default 1800s order a full 1800s of headroom over the module's `validTo <=
block.timestamp + maxTtl` check - so it validates even though the L2 block
timestamp can lag the builder's wall clock. Do NOT deploy with `maxTtl = 1800`:
that leaves zero slack and reverts `BadValidTo`. For tighter curator orders, pass
a shorter `ttlSeconds` (e.g. 1500) and you may lower `maxTtl` to match - keep at
least a few minutes of headroom over `ttlSeconds` for block-timestamp lag. The
actual price-exposure window is the order's `ttlSeconds`; `maxTtl` is only the
ceiling.

## Step 6 — verify

- `settlement.preSignature(orderUid)` == the PRE_SIGNED marker.
- Relayer allowance for the sell token == the order's sellAmount (exact).
- After the solver fills: buy token lands in the Safe (receiver == Safe).
- The Ophis partner fee is attributed to the fee recipient Safe
  `0x858f0F5e…CeF8` (arrives on the next sweep once the buffer clears the
  0.001-token threshold; a below-threshold buffer is expected, not a failure).

## Rollback / stop

The Safe owners retain full custody at all times. To stop the curator: disable
the module on the Safe (`disableModule`), or `cancel` any open order. Phase B
constrains the curator, never the owners.

## Residual risk (Phase-B, documented)

A compromised curator can still bleed at most `oracle-floor − slippage` per
order, bounded by the daily USD turnover cap (~2x per rolling 24h). Fully
closing this is Phase-B-2 (EIP-1271 order validator). Until then the curator key
is effectively equivalent to full vault custody within that per-day bound —
size `VAULT_CAP` accordingly for a trial.
