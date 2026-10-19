---
id: vault-managers
title: Vault manager rebalancing
description: Rebalance your vault or treasury Safe with onchain rules for tokens, prices and turnover.
sidebar_label: Vault managers
sidebar_position: 4
---

# Vault manager rebalancing

Rebalance your vault or treasury Safe through CoW Protocol with onchain rules for tokens, prices and turnover.

## How it works

<Cards>
<Card icon="vault" title="Vault Safe">Your Safe holds the assets and receives the bought tokens.</Card>
<Card icon="shield-check" title="Policy module">OphisVaultPolicyModule checks each order before authorizing it.</Card>
<Card icon="key-round" title="Curator key">Your curator calls rebalance and cancel within the module's rules.</Card>
</Cards>

The curator can be an EOA, MPC signer or multisig. It must be separate from the Safe's owners and enabled modules. The constructor rejects a curator with either role.

The Safe is both `order.from` and `order.receiver`. Sold tokens leave at settlement, and bought tokens return to the Safe. Each order carries the Ophis partner fee.

## Policy checks

Every `rebalance(order, minBuyOverride)` call checks the order onchain and reverts if a rule fails.

| Check | Rule |
| --- | --- |
| Receiver | `receiver == the Safe` |
| Token allowlist | Both tokens must be in the configured list. |
| Chainlink oracle floor | The minimum buy amount must meet the oracle band at presign time; the default is 50 bps. Stale or invalid rounds are rejected. |
| Pinned appData | The order must carry the exact fee metadata fixed at deployment. |
| Signed fee | `feeAmount` must be zero; fees use appData. |
| Order expiry | 33 minutes in the deploy scripts, allowing for the builder's 30-minute order plus lag margin. |
| Turnover capacity | A shared USD bucket refills over 24 hours and can admit approximately twice its capacity in a rolling 24-hour window. |
| L2 sequencer | Oracle reads stop during sequencer downtime and the recovery grace period. |

After the checks pass, the module sets an exact-amount allowance for the settlement relayer and presigns the order. Each presign permits one full fill. The allowance returns to zero after a fill or `cancel`.

## Multi-token vaults

You can rebalance any allowlisted token into another, such as USDC, WETH, WBTC or DAI.

| Setting | Requirement |
| --- | --- |
| Token count | Minimum two; the upper limit depends on gas. |
| Price feeds | Each token needs a Chainlink USD feed and staleness window. |
| Oracle floor | Uses the sell-token/USD and buy-token/USD cross-rate minus the slippage band. |
| Token type | Fee-on-transfer and rebasing tokens are excluded from rebalancing. |
| Active orders | One live presigned order per sell token. |
| Turnover budget | Shared across every token. |
| Policy changes | Deploy and enable a new module to change tokens, feeds or caps. |

An unlisted token is rejected as `TokenNotAllowed`. Your vault can still hold assets excluded from rebalancing.

## Operational chains

The `@ophis/safe-swap` v0.1.7 builder uses SDK v0.4.4 and supports these 14 chains.

| Orderbook | Chains |
| --- | --- |
| Ophis self-hosted | Optimism, Unichain, Robinhood Chain (4663), Arc (5042) |
| CoW-hosted | Ethereum, Base, Arbitrum One, Polygon, Gnosis Chain, BNB Smart Chain, Avalanche, Linea, Ink, Plasma (9745) |

Use ERC-20 token addresses on Arc; native-token sentinels are rejected. Plasma orders use CoW's production Plasma orderbook and canonical settlement.

## Deployment addresses

Each vault deploys a module through a factory with its own Safe, curator, token allowlist and caps.

| Chain | Module factory | Settlement |
| --- | --- | --- |
| Ethereum (1) | `0xd6e80ca05b8bfebdaf6338b1f22f98f065ce96f4` | Canonical CoW |
| Optimism (10) | `0xd6e80ca05b8bfebdaf6338b1f22f98f065ce96f4` | Ophis self-hosted |
| Base (8453) | `0xd6e80ca05b8bfebdaf6338b1f22f98f065ce96f4` | Canonical CoW |
| Arbitrum One (42161) | `0xd6e80ca05b8bfebdaf6338b1f22f98f065ce96f4` | Canonical CoW |
| Unichain (130) | `0x251195c88639fa9364302D51E649910A2537ee9d` | Ophis self-hosted |
| Plasma (9745) | `0x8bfd02f98854647f4235d770a284ddbbac0bf2ca` | Canonical CoW |

The Plasma module uses WXPL/USDT0 with Chainlink XPL/USD and USDT0/USD feeds. Plasma has no native USDC.

## Set up rebalancing {/* #implementing-it */}

The [operator runbook](https://github.com/ophis-fi/ophis/blob/main/docs/operations/vault-policy-module-trial-runbook.md) contains deployment scripts and checks for each chain.

<Steps>

1. **Derive the appData hash.** Pin the document containing the chain, fee metadata and your Safe as signer.
2. **Deploy your module.** Use the factory and the per-chain scripts in [`contracts/script/`](https://github.com/ophis-fi/ophis/tree/main/contracts/script). The constructor validates the feeds and settlement.
3. **Enable the module.** Have the Safe owners sign `enableModule(module)`.
4. **Build and submit an order.** Use `@ophis/safe-swap`, then have the curator call `module.rebalance(order, minBuyOverride)`.

   ```ts
   import { buildOphisSafePresign } from '@ophis/safe-swap'

   const { orderUid, order } = await buildOphisSafePresign({
     chainId: 10,
     safe: VAULT_SAFE,
     sellToken: USDC,
     buyToken: WETH,
     sellAmount: '250000000000',   // atomic units
     slippageBps: 30,
     ttlSeconds: 1500,             // keep under the module's maxTtl
   })

   // The curator then calls, from its own key:
   //   module.rebalance(order, minBuyOverride)
   // The module re-derives the same orderUid, re-checks every field on-chain,
   // sets the exact allowance, and presigns. Solvers settle it like any CoW order.
   ```

</Steps>

| Setting | Deployment value |
| --- | --- |
| Module `maxTtl` | 1980s |
| Builder default TTL | 1800s |
| Oracle floor band | 50 bps |

:::tip
Leave TTL headroom for block-timestamp lag. The oracle band must cover slippage plus the quote fee. If an order fails with `BelowFloor`, rebuild with tighter slippage or retry after the next oracle update; the failed call signs nothing and moves no funds.
:::

## Security model

The module checks the oracle floor only at presign time. Price movement before the fill, fees and repeated trades can reduce vault value. Set turnover capacity no higher than half your intended rolling-day tolerance to account for the bucket's refill.

The module is immutable. To change its policy, deploy a new module and migrate your Safe.

:::warning
Disabling the module leaves existing presignatures and allowances active. Resolve outstanding orders before disabling it, while the curator can still call `cancel`. Keep its token allowances separate from other enabled modules.
:::

<Steps>

1. **Resolve outstanding orders.** Have the curator cancel recorded orders or wait for them to expire.
2. **Clear allowances.** Follow the runbook to clear remaining token allowances.
3. **Disable the old module.** Safe owners call `disableModule` to block new module calls.

</Steps>

## Rebalance fees {/* #fees */}

| Fee | Rate |
| --- | --- |
| Base | 1 bp |
| Volatile pairs | 80% of reference-quote improvement, capped at 99 bps |
| Stable pairs | 50% of reference-quote improvement, capped at 20 bps |
| CoW-hosted orders | CoW Protocol's upstream fees also apply. |

Ophis-operated backends apply the improvement policy. CoW-hosted orders encode it in CIP-75 appData.

## Next

<Cards>
<Card icon="receipt" title="Fees" href="/fees">Read the swap fee schedule.</Card>
<Card icon="shield-check" title="Security & audits" href="/audits">Review settlement controls and security reports.</Card>
<Card icon="activity" title="Status" href="/status">Check orderbook availability before submitting orders.</Card>
</Cards>
