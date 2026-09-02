---
title: "Ophis on Robinhood Chain: gasless, MEV-protected Stock Token swaps"
description: "Ophis runs a sovereign deployment on Robinhood Chain (chain 4663): its own GPv2Settlement, orderbook, and solver lanes, with chain-aware pricing."
pubDate: 2026-07-31
author: Ophis
tags: [robinhood-chain, stock-tokens, dex-aggregator, mev, swaps]
draft: false
cover: ./swap-on-robinhood-chain.cover.jpg
coverAlt: "Ophis emblem ringed by supported chains with the Robinhood feather as the featured node"
---

Ophis is live on Robinhood Chain. Open [swap.ophis.fi/#/4663/swap](https://swap.ophis.fi/#/4663/swap), connect a wallet, and sign an EIP-712 order: for an ERC-20 sell you do not broadcast the settlement transaction or pay its gas (selling native ETH is the exception covered below). Solver lanes route the pair and the winning settlement lands through Ophis's `GPv2Settlement` at `0x886d9fd312F442C4E1f3cdeAE7b4AB73493e57cD`. Pricing is a 1 bp base plus capped reference-quote-improvement capture. Robinhood Chain is the third network where Ophis runs its own orderbook and settlement contracts rather than routing through CoW Protocol's hosted stack, and the first where the tradable universe is mostly Stock Tokens and other tokenized real-world assets.

Two sentences of context. Robinhood Chain is chain id 4663, an Arbitrum Orbit L2, and it is one of the 13 EVM chains [Ophis](https://ophis.fi/) supports. Ophis is an intent-based DEX aggregator, a fork of [CoW Protocol](https://docs.cow.fi)'s frontend with a natural-language intent layer and an agent stack on top, and on Robinhood Chain it runs a sovereign deployment whose specifics are the subject of the rest of this post.

Ophis is an independent protocol and is not affiliated with, endorsed by, or officially connected with Robinhood Markets, Inc. Stock Token eligibility and jurisdictional restrictions apply; review [Robinhood's current disclosures](https://robinhood.com/rhj/stocktokens/) before interacting with them.

## Swap on Robinhood Chain, step by step

1. **Open the app pinned to the chain.** `https://swap.ophis.fi/#/4663/swap` loads the swap form already pointed at Robinhood Chain. The `4663` is the chain id.

2. **Connect your wallet.** Ophis is self-custodial. It never holds your funds, and nothing moves without a signature from your wallet (EIP-712 for regular accounts, ERC-1271 for smart-contract accounts).

3. **Pick the pair, or describe it.** Fill in sell token, buy token, and amount, or type the trade in plain language and let the intent layer fill the form.

4. **Read the asset panel.** On Robinhood Chain the swap form shows a panel specific to this network. If either side of your pair is an official Robinhood Stock Token, it names the asset, reports its corporate-action multiplier, and flags any trading restriction currently in force. More on what that check actually does below.

5. **Review the quote and sign.** The quote carries a hard limit price, and that limit is what you sign: the worst execution you can receive. Your wallet shows typed data, not a transaction. Orders are gasless, and the fee comes out of the traded amount rather than being billed separately.

6. **Wait for settlement.** Solvers race to fill the order and the winner settles it on-chain in a batch. Order status updates on the page until the trade lands.

## What Robinhood Chain is, under the hood

This is the part that diverges most from the rest of the Ophis fleet. Optimism and Unichain are OP-Stack chains, so the sovereign playbook there is `op-reth` plus `op-node`. Robinhood Chain is an **Arbitrum Orbit L2 running stock Offchain Labs Nitro**, so none of that applies.

| Property | Value |
| --- | --- |
| Chain id | 4663 (`0x1237`) |
| Stack | Arbitrum Orbit, Offchain Labs Nitro |
| Data availability | Rollup mode, EIP-4844 blobs posted to Ethereum L1 (not AnyTrust, so there is no DAC) |
| Block time | around 134ms, which is roughly 900,000 blocks a day |
| Native currency | ETH |
| Public RPC | `https://rpc.mainnet.chain.robinhood.com` |
| Explorer | [robinhoodchain.blockscout.com](https://robinhoodchain.blockscout.com) |
| Wrapped native | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` |
| Canonical stablecoin | USDG, 6 decimals, `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` |

Two details from that table shaped the deployment more than anything else.

The first is the RPC surface. Robinhood's public endpoint serves `net`, `web3`, and `eth` only. It has no `debug`, no `arb`, and no `arbtrace`. The Ophis autopilot requires `debug_traceTransaction` to decode settlement calldata, so Robinhood's public RPC alone could not carry the stack: Ophis runs its own Nitro node with the trace namespaces enabled, and that node is currently the only trace source in the stack.

The second is how that node gets its state. A Nitro node reconstructs L2 state by replaying the chain's data availability from Ethereum L1, which for this chain means EIP-4844 blobs, and blobs are not retained forever. Measured against a public beacon endpoint, retention ran roughly 45 to 50 days, while the rollup was deployed at L1 block `24994238` on 2026-04-30. Verifying from genesis therefore needs a blob source reaching past standard beacon retention, which the stack has in a narrow, fail-closed archive adapter.

The node in production did not take that route. Robinhood publishes no official snapshot, so the Cadia node was restored from a third-party one to reach the tip in reasonable time. That is worth stating plainly, because it is the reason for a design decision further down: a restored snapshot's flat state layer cannot be validated by checking a few block hashes, so its state reads are not self-verifying. Protected reads are 2-of-2 against Robinhood's public RPC precisely to compensate for that, rather than because two voters are inherently better than one.

## The sovereign deployment

On most of its chains Ophis settles through CoW Protocol's canonical audited GPv2 contracts via `api.cow.fi`. On Optimism, Unichain, and Robinhood Chain it does not: it runs its own orderbook and a bytecode-identical deployment of CoW Protocol's audited GPv2 suite at non-canonical addresses. The core suite was deployed on 2026-07-25; the EthFlow contract followed on 2026-07-28.

| Contract | Address |
| --- | --- |
| `GPv2Settlement` | `0x886d9fd312F442C4E1f3cdeAE7b4AB73493e57cD` |
| `GPv2VaultRelayer` | `0xB52C38097c19cd38238c62DD36027a7918eFa890` |
| `GPv2AllowListAuthentication` | `0x5c802B14d9E132717aE78D42B19a4c517876F2E7` |
| `CoWSwapEthFlow` | `0xC1Ee77e8a1B85D5EED702a9bB435f434408A4d29` |
| Orderbook | [robinhood-mainnet.ophis.fi](https://robinhood-mainnet.ophis.fi) |

Protocol authority over the authenticator, which is the contract that decides who is allowed to settle, is held by a 2-of-3 Safe at `0xe049a64546fb8564CC4c7D64A0A1BAe00Aa801cF`. The EthFlow contract that handles native-ETH sells is ownerless and was constructor-wired to the settlement contract and to Robinhood's wrapped native token, so selling native ETH works on this chain the same way it does on Unichain.

If you swap through the app, none of this is visible and none of it needs to be. It matters if you integrate programmatically, in exactly one way that bites hard: an order built for CoW's canonical settlement domain will not verify against this deployment. The EIP-712 domain separator is derived from the chain id and the settlement address, so a canonical address produces a domain the deployed contract rejects. Resolve the settlement domain and orderbook host per chain through `@ophis/sdk` (0.3.0 on npm) or the MCP `list_chains` tool. Do not hardcode either.

## Three active solver lanes

A sovereign deployment is only as good as the liquidity its solvers can reach. Robinhood Chain liquidity is Uniswap V4, which the CoW baseline solver cannot read, so on this chain baseline ships empty and three other lanes do the work.

- **LI.FI.** A same-chain aggregator lane. One chain-specific catch: on 4663 the LI.FI router is `0xB477751B76CF82d00a686A1232f5fCD772414Af3`, not the LiFiDiamond address used elsewhere. It has to be allowlisted in both the solver and the driver, or every quote fails the same-chain safety check.
- **KyberSwap.** A second independent aggregator lane whose route builder reaches the deployed Robinhood DEX liquidity. The solver and driver pin its router through a static allowlist.
- **Direct Uniswap V4.** The newest lane, and the only one that depends on no external route API at all. It reads quotes from Uniswap's canonical V4Quoter through the sovereign eRPC proxy, and it executes through `OphisUniswapV4Adapter` at `0x8573C5Fcf5BD890f4EDD4a41e783Eac552B307ae`. It is deliberately narrow: it bids only on the pair it serves, so on any other pair, Stock Tokens included, the field is whichever aggregator lanes can actually return a route.

That narrowness is the point, because the adapter is where the security posture of the lane lives. It is immutable and pair-specific: it serves the canonical native ETH/USDG V4 pool and nothing else. It cannot route arbitrary tokens, cannot call arbitrary hooks, cannot be repointed at a different pool, and cannot send output anywhere except the Ophis settlement contract. Ophis orders trade wrapped tokens while the V4 pool is native, so the adapter performs the wrap and unwrap atomically around the swap.

One Arbitrum-specific quirk surfaced while making that lane safe to simulate. Robinhood's canonical wrapper is upgradeable aeWETH, not WETH9, and its `balanceOf` mapping sits at storage slot 51 rather than WETH9's slot 3. Simulating a settlement against the WETH9 default reads the wrong slot and produces balances that do not exist. The solver now overrides the verified slot.

All three lanes run under the same bounds: 1% relative slippage and an absolute cap of 0.04 ETH, tightened from the 10% default because this chain's trades are small and loose bounds are what MEV feeds on.

## Stock Tokens: what Ophis checks before you sign

Most chains list tokens. Robinhood Chain mostly lists Stock Tokens and other tokenized real-world assets. The exact set is a live, changing registry, so rather than quote a number that will be stale by the time you read this, here is the floor the stack is built to expect: Ophis's daily canary fails if the registry returns fewer than 80 assets, or if the default token list exposes fewer than 80 of them on chain 4663. For the current list, read `swap.ophis.fi/api/robinhood/assets` directly. These instruments behave in ways an ERC-20 router has no concept of, so Ophis added a Robinhood-specific verification path in front of the quote.

**It confirms the token is the canonical deployment.** The panel matches the selected token address against Robinhood's own published registry, scoped to chain id 4663. A token that merely calls itself AAPL does not match. This is the same anti-spoofing principle the `resolve_token` MCP tool applies, which matters more here than usual: a fake equity-linked token is a far more convincing lure than a fake memecoin.

**It reads the corporate-action multiplier.** A Stock Token's on-chain balance is not necessarily one-for-one with underlying shares. Each asset carries a multiplier, and the panel uses it to show what your balance represents. Most assets sit at exactly 1, so the distinction never surfaces, but not all of them do, and which ones changes over time. The mechanic is worth understanding before it matters to you: at a multiplier of 4, a balance of 10 tokens is shown as representing about 40 underlying shares. Read the current value per asset rather than assuming it is 1. When Robinhood publishes a multiplier change ahead of its effective time, the panel says a change is pending instead of quietly repricing after the fact.

**It surfaces trading restrictions.** Each asset publishes a trading status per session, across market, extended, and overnight hours, and separately for whole and fractional quantities. If any of them is anything other than tradable, or if the asset itself is not active, the panel switches to an attention state naming the affected symbol.

**It fails visibly, not silently.** If the registry cannot be reached, Ophis does not pretend everything is verified. The panel says metadata is temporarily unavailable, notes that restrictions and multipliers could not be checked, and leaves quoting available so you can decide. Whatever the panel reports, the executable price is always the solver quote.

The registry itself needed a small piece of infrastructure. Robinhood's first-party endpoint intentionally serves no browser CORS headers, so the swap app cannot read it directly. Ophis fronts it with a same-origin edge function that fetches upstream with a 5-second timeout, streams the body under a 1MB cap, rejects payloads over 500 assets, and then re-shapes every asset through a validator rather than passing the upstream JSON through. Addresses must match `^0x[0-9a-fA-F]{40}$`, the current multiplier must match a bounded decimal pattern and be strictly positive, deployment and capability collections are count-capped, and every string field has a length cap. If a single asset fails validation the whole response is rejected as a 502 rather than partially trusted. Valid responses are cached for 60 seconds in the browser and 300 at the edge.

## Why the stack pauses instead of guessing

As deployed today, the stack has exactly one trace source, the self-hosted Nitro node, because the public RPC does not serve `debug_traceTransaction` at all. That is a choice rather than a law: managed providers do offer trace access for 4663, and adding one would buy availability. It would not buy independence for free, since it swaps one external party's trace output for another's. Until that trade is made, the stack is built to stop rather than to improvise.

- **Reads are 2-of-2.** Protected reads require agreement between the Ophis Nitro node and Robinhood's official public RPC. If the two disagree, or either is unreachable, the read fails rather than falling back to a single voter. That is the mitigation for the restored snapshot: a second independent voter on the reads that gate settlement.
- **The residual trust is in traces, and it is worth naming.** The quorum covers those reads. It does not cover `debug_traceTransaction`, which only the Cadia node can serve. A snapshot with tampered state returns wrong values rather than errors, so a fail-closed guard has nothing to trip on, which means each trace is ultimately only as trustworthy as the snapshot's publisher. Closing that properly means a second independently derived node, not a second opinion on the same data.
- **Traces are single-source and gated.** Without a trace, the autopilot pauses settlement. It does not settle a batch it cannot decode.
- **The topology is locked in CI.** A check named `assert-erpc-failclosed.py` fails the build if the proxy configuration drifts toward failing open. A guard that cannot fail is worse than no guard, so this one is asserted in CI rather than assumed.
- **Production is re-verified daily.** A read-only canary re-checks chain identity, that the settlement, relayer, and EthFlow addresses it pins still carry code, that `settlement.vaultRelayer()` still returns the pinned relayer, that WETH still reports 18 decimals and USDG 6, that the stock-token registry still resolves and AAPL's on-chain `uiMultiplier()` is non-zero, that the default token list still exposes the canonical AAPL address, and that all three sovereign orderbooks still answer with a live auction id and block.

The canary carries its own copy of the addresses, so what it catches is the deployment drifting away from that pinned set: a relayer rewired, a token's decimals changing under an upgradeable proxy, a registry that stops resolving, an orderbook that stops producing auctions. It is a daily assertion that the chain still looks the way the stack assumes it does.

## Fees and rebates

Every trade pays a 1 bp base. Ophis also retains 80% of reference-quote improvement on volatile pairs, capped at 99 bps of volume, or 50% on stablecoin pairs, capped at 20 bps. The trader receives the remainder and all improvement above the cap. Because Robinhood Chain is Ophis-operated, there is no upstream CoW-hosted fee layer.

Volume then earns part of it back, on rolling 30-day volume:

| Tier | 30-day volume | Rebate |
| --- | --- | --- |
| Bronze | $20,000+ | 10% |
| Silver | $50,000+ | 15% |
| Gold | $100,000+ | 25% |
| Palladium | $500,000+ | 35% |
| Platinum | $1,000,000+ | 50% |

Rebates are paid monthly in WETH from the fee Safe, out of a pool of 21.25% of collected WETH fees, split by tier-weighted 30-day volume. Your tier and progress show on the swap page, and the [fee docs](https://docs.ophis.fi/fees) carry the full mechanics.

## Building on Robinhood Chain

The chain is wired through the whole Ophis stack, not just the app: the frontend, the SDK, the MCP server, the compatibility API, and the Safe app all carry checked Robinhood contract mappings.

- **MCP server.** [`https://mcp.ophis.fi/mcp`](https://mcp.ophis.fi/mcp) is keyless and unauthenticated, with fourteen tools covering every supported chain. `list_chains` resolves the Robinhood orderbook host and settlement domain, `build_order` returns a bounded order with the receiver pinned to the owner, and the server never holds keys and never signs. The [agent walkthrough](/blog/let-an-ai-agent-swap-tokens/) covers the safety model.
- **SDK.** `@ophis/sdk` 0.3.0 resolves the orderbook URL, the EIP-712 signing domain, the vault relayer, and the EthFlow address per chain. On a sovereign chain that is the difference between an order that verifies and one that does not.
- **Widget.** `@ophis/widget-react` embeds the swap form directly. See the [widget docs](https://docs.ophis.fi/widget).
- **Affiliate.** Mint a referral code and earn 8% of the verified base fee Ophis keeps on trades your referred wallets route, paid monthly in WETH. Details in the [affiliate docs](https://docs.ophis.fi/affiliate).

If you want the same walkthrough for the other two Ophis-operated chains, read [how to swap on Optimism](/blog/how-to-swap-on-optimism/) and [how to swap on Unichain](/blog/how-to-swap-on-unichain/).

## FAQ

### Is Ophis live on Robinhood Chain?

Yes. Ophis deployed its core sovereign contracts on Robinhood Chain (chain 4663) on 2026-07-25, added the EthFlow contract for native-ETH sells on 2026-07-28, and trading is live at [swap.ophis.fi/#/4663/swap](https://swap.ophis.fi/#/4663/swap). Orders settle through an Ophis-deployed GPv2Settlement at `0x886d9fd312F442C4E1f3cdeAE7b4AB73493e57cD`, served by an Ophis-operated orderbook at `robinhood-mainnet.ophis.fi`. Three solver lanes are live: LI.FI, KyberSwap, and a direct Uniswap V4 lane that is restricted to the native ETH/USDG pool.

### Do I need ETH on Robinhood Chain to pay gas?

No. Orders are gasless: you sign an EIP-712 typed-data message rather than broadcasting a transaction, the winning solver pays the settlement gas, and the Ophis fee is deducted from the traded amount rather than charged separately. You do need a small amount of ETH for a one-time on-chain approval the first time you sell a given token, and for wrapping if you choose to wrap manually.

### Can I swap Stock Tokens on Robinhood Chain?

Yes, and Ophis adds checks specific to them. Before you sign, it verifies the token is the canonical deployment listed in Robinhood's official registry for chain 4663, reports the asset's corporate-action multiplier so you can see how the balance maps to underlying shares, flags any pending multiplier change, and warns when an asset carries a trading restriction in market, extended, or overnight sessions. The registry is live and its contents change, so read `swap.ophis.fi/api/robinhood/assets` for the current set. If that metadata cannot be fetched, Ophis says so rather than presenting the trade as verified.

### How is Robinhood Chain different from the other chains Ophis supports?

Technically it is an Arbitrum Orbit L2 running Offchain Labs Nitro, posting data availability as EIP-4844 blobs to Ethereum, whereas Ophis's other two sovereign chains, Optimism and Unichain, are OP-Stack. Its public RPC serves no trace namespaces, so Ophis runs its own Nitro node to supply `debug_traceTransaction` and pauses settlement when that node is unavailable. Its liquidity is Uniswap V4, so the CoW baseline solver ships empty and three other solver lanes do the work. Commercially it is Ophis-operated, so it uses the 1 bp base plus capped improvement-capture schedule without an upstream CoW fee.

### Does a higher gas price get my order filled first?

No. A normal ERC-20 order is an off-chain signed message rather than a transaction, so it carries no gas bid at all: there is no priority fee attached to it and nothing for anyone to outbid. What protects it from sandwiching is that the order flow stays off-chain until settlement and then settles in a batch, not the gas market.

One exception is worth knowing, because this post advertises it. Selling native ETH goes through the EthFlow contract, and that placement really is an on-chain transaction: you broadcast a payable `createOrder` call, it costs gas, and it is visible like any other transaction. What it creates is still an order that settles in a batch on the same terms as the rest. Approvals and wrapping are ordinary transactions too, and also cost gas.

### What happens if my order cannot be filled?

For an ERC-20 order, nothing lands on chain and you pay nothing. The order is a signed message rather than a broadcast transaction, so there is no failed transaction to pay gas for: if no solver can fill it at or above your signed limit before it expires, it simply expires. Execution below the limit you signed cannot settle at all.

Selling native ETH differs, because placing that order is itself an on-chain EthFlow transaction. That placement already cost gas and already moved your ETH into the contract, so an unfilled order there is not free: it ends in a refund of the ETH rather than in nothing having happened. The limit price protects you the same way in both cases.

## Start swapping

Open [swap.ophis.fi/#/4663/swap](https://swap.ophis.fi/#/4663/swap), connect a wallet, and sign your first Robinhood Chain order. ERC-20 settlement is gasless, the signed limit is enforced, and Stock Token checks run before signing. If you are integrating rather than trading, start from the [getting-started guide](https://docs.ophis.fi/getting-started) and resolve the chain's settlement domain and fee through the SDK.
