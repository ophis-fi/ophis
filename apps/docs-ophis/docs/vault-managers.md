---
id: vault-managers
title: Vault manager rebalancing
description: Rebalance a vault or treasury Safe through Ophis behind an on-chain policy module, so a compromised curator key cannot drain the vault.
sidebar_label: Vault managers
sidebar_position: 4
---

# Vault manager rebalancing

If you run a vault or treasury from a Safe, rebalancing its underlying assets
usually means handing an operations key the power to move funds. Ophis removes
that trade-off: the curator key can trigger swaps, but an on-chain policy
module checks every order against a fixed rulebook before anything is signed.
A compromised curator key cannot redirect funds, cannot trade unlisted tokens,
and cannot accept a bad price.

The flow settles through CoW Protocol as one atomic, MEV-protected order. The
vault Safe is both `order.from` and `order.receiver`, so funds never leave its
control, and each order carries the Ophis partner fee.

## How it works

Three parties, three roles:

- **The vault Safe** holds the assets. Its owners keep full custody at all
  times and can disable the module whenever they want.
- **The policy module** (`OphisVaultPolicyModule`) is a Safe module the owners
  enable once. It is the only path from the curator to the Safe.
- **The curator** is a dedicated key (EOA, MPC signer, or multisig) that may
  call exactly two functions on the module: `rebalance` and `cancel`. It must
  not be a Safe owner and must not be an enabled Safe module; the module
  rejects both at deploy time.

On every `rebalance(order)` call the module re-checks the full order on-chain
and reverts if any rule fails:

| Check | Guarantee |
|---|---|
| `receiver == the Safe` | Proceeds can only ever return to the vault |
| Token allowlist | Only the underlyings the owners configured can trade |
| Chainlink oracle floor | The order's minimum out must be within the configured band (default 50 bps) of the live oracle price. Stale or invalid oracle rounds fail closed |
| Pinned appData | The order carries the exact Ophis fee metadata the owners froze at deploy; nothing can be swapped in |
| Zero signed fee | The fee rides in appData only; a nonzero signed `feeAmount` is rejected |
| TTL ceiling | Orders cannot outlive the configured window (the deploy scripts use 33 minutes: the builder's 30-minute order plus lag margin) |
| Daily turnover cap | A rolling USD budget (leaky bucket) bounds how much value the curator can move per day |
| L2 sequencer gate | On L2s, oracle reads are refused while the sequencer is down and during a grace period after recovery |

Only when every check passes does the module set an exact-amount allowance to
the settlement relayer and presign the order in the CoW settlement. After a
fill (or a `cancel`) the allowance returns to zero. Fill-or-kill semantics
mean each presign backs at most one fill.

The module is immutable: no owner, no setters, no upgrade path. Changing
policy means deploying a new module and switching over.

## Multi-token vaults

The USDC/WETH pair in the examples is just the smallest case. The module is
built with a LIST of tokens, each paired with its own Chainlink USD price feed
and staleness window. The minimum is two, and there is no fixed upper bound
beyond gas. A vault holding USDC, WETH, WBTC, and DAI, for instance, deploys
with four entries.

How the token set behaves:

- **Any allowlisted token into any other.** The oracle floor is a cross-rate:
  for a sell of A into B the module reads A/USD and B/USD and requires the order
  to clear the implied price minus the slippage band. The curator rotates freely
  within the allowlist, always price-checked. A token that is not on the list is
  rejected as `TokenNotAllowed`.
- **One shared daily budget, denominated in USD.** The turnover cap is global
  across every token, not per token, so a compromised curator cannot multiply
  its reach by rotating through many assets. One bucket bounds the whole vault.
- **One live order per sell token.** Allowance tracking is per sell token, so
  there is never more than one in-flight presigned order per token sharing an
  allowance (the property the audit's regression invariant locks down).
- **The set is fixed at deploy.** The module is immutable, so adding or removing
  a token means deploying a fresh module and re-enabling it. That is the
  deliberate trade for having no admin function that could inject a malicious
  token or feed.

Two requirements for a token to be allowlistable:

- It needs a Chainlink USD feed, which is how the module prices it.
- It must not be fee-on-transfer or rebasing. The floor is computed on the gross
  sell amount, which those token types do not deliver in full, so they are
  excluded. A vault can still HOLD such assets; it just cannot rebalance them
  through this module.

## Live deployments

The module is live and has settled real rebalances on five chains. The
contracts are identical everywhere; the per-chain difference is which
settlement they gate and which Chainlink feeds they read.

| Chain | Module factory | Settlement |
|---|---|---|
| Ethereum (1) | `0xd6e80ca05b8bfebdaf6338b1f22f98f065ce96f4` | Canonical CoW |
| Optimism (10) | `0xd6e80ca05b8bfebdaf6338b1f22f98f065ce96f4` | Ophis self-hosted |
| Base (8453) | `0xd6e80ca05b8bfebdaf6338b1f22f98f065ce96f4` | Canonical CoW |
| Arbitrum One (42161) | `0xd6e80ca05b8bfebdaf6338b1f22f98f065ce96f4` | Canonical CoW |
| Unichain (130) | `0x251195c88639fa9364302D51E649910A2537ee9d` | Ophis self-hosted |

Plasma (9745) is next: the deploy tooling and fork preflight are verified
against live Plasma state (canonical CoW settlement, WXPL/USDT0 allowlist), and
it joins the table once its first vault is live.

Each vault deploys its own module instance through the factory, configured
with its own Safe, curator, allowlist, and caps.

## Implementing it

The end-to-end operator guide (with verified per-chain addresses, deploy
scripts, and fork preflights) lives in the repo:
[`docs/operations/vault-policy-module-trial-runbook.md`](https://github.com/ophis-fi/ophis/blob/main/docs/operations/vault-policy-module-trial-runbook.md).
The short version:

**1. Derive the appData hash to pin.** The module accepts only orders carrying
one exact appData document (chain, fee metadata, your Safe as signer). Derive
its hash once and pass it to the deploy.

**2. Deploy your module through the factory.** Per-chain forge scripts with
verified feed and token addresses are in
[`contracts/script/`](https://github.com/ophis-fi/ophis/tree/main/contracts/script).
The constructor probes every configured Chainlink feed and the settlement at
deploy, so a mis-configured deploy reverts instead of shipping.

**3. Enable the module on your Safe.** One `enableModule(module)` transaction
signed by the Safe owners. From this point the curator can rebalance and the
owners retain everything else.

**4. Build and submit orders with `@ophis/safe-swap`.** The published npm
package quotes against the orderbook, assembles a hardened, receiver-pinned
order, posts it, and returns the exact struct the module expects:

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

Practical notes from the live rollout:

- Give the module's `maxTtl` headroom over the order TTL (the deploy scripts
  use 1980s vs the builder's default 1800s) so block-timestamp lag never
  rejects a fresh order, while keeping the fill window tight.
- The oracle floor band (50 bps) must cover the order's slippage plus the
  quote fee. On L1, fees on very small orders can exceed the band; size orders
  so the fee is a few basis points and this never matters. Production-size
  rebalances are unaffected.
- If the floor rejects an order (`BelowFloor`), nothing was signed and no
  funds moved. Rebuild with tighter slippage or retry after the next oracle
  update.

## Security model

The module's guarantee is deliberately narrow and testable: **a compromised
curator key cannot drain the vault.** The worst it can do is trigger
policy-valid rebalances between allowlisted tokens, at prices within the
oracle band, bounded by the daily turnover cap. The disclosed residual is
price bleed inside that envelope: at most the floor band per order, capped by
the daily budget.

The contracts went through a 12-agent adversarial audit, Trail of Bits semgrep
rules, Echidna and Foundry invariant fuzzing (including a regression invariant
for the one-live-order-per-token allowance discipline), and independent review,
with fork preflights against real chain state gating every deploy. During the
live rollout the oracle floor rejected mispriced orders in production exactly
as designed.

Vault owners keep an unconditional exit: `disableModule` ends the curator's
access instantly, and `cancel` revokes any open order.

## Fees

Rebalances carry the standard Ophis partner fee (5 bps SDK tier) in the pinned
appData, attributed on settlement. See [Fees](/fees) for the full schedule.

## FAQ

**What problem does this actually solve?**

Running an active vault strategy normally means giving an operations key the
power to move funds, which is the same power needed to steal them. The policy
module separates the two. The curator key can trigger swaps but can only ever
produce policy-valid orders: proceeds back to the vault, allowlisted tokens,
oracle-priced, capped daily volume. A leaked or rogue curator key cannot
redirect a single token out of the vault. At worst it can make slightly-off but
policy-valid trades, bounded by the daily budget.

**What does a vault manager have to do to start using it?**

Four steps: deploy a module for your Safe from the per-chain factory; enable it
on the Safe with one owner-signed `enableModule` transaction; build orders with
the `@ophis/safe-swap` package; and have the curator key call
`module.rebalance(order)`. Funds never leave the Safe, and the owners can
`disableModule` at any time. The
[runbook](https://github.com/ophis-fi/ophis/blob/main/docs/operations/vault-policy-module-trial-runbook.md)
has the full sequence.

**Can a vault rebalance more than two tokens?**

Yes. The module takes a list of tokens, each with its own price feed, minimum
two and no fixed upper bound. See [Multi-token vaults](#multi-token-vaults) for
how the allowlist, the shared USD budget, and the fixed-at-deploy token set
behave.

**Why is the module factory at a different address on Unichain?**

A contract's address is derived from its deployer and that deployer's nonce. On
Ethereum, Optimism, Base, and Arbitrum the factory was the deployer's first
transaction on each chain, so it landed at the same address everywhere. On
Unichain the deployer had already transacted, so the factory came out at a
different nonce and therefore a different address. It is the same factory
contract in every case.
