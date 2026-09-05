---
title: "Coinbase tokenized stocks on Base: swap AAPLc, NVDAc on Ophis"
description: "Coinbase tokenized stocks are live on Base and listed on Ophis. Swap AAPLc, NVDAc, METAc and GOOGLc gasless and MEV-protected, multiplier read on chain."
pubDate: 2026-08-24
updatedDate: 2026-08-25
author: Ophis
tags: [base, tokenized-stocks, coinbase, b20, dex-aggregator, swaps]
draft: false
cover: ./coinbase-tokenized-stocks-on-base.cover.jpg
coverAlt: "Ophis emblem at the centre of an orbit ring of nodes, with the Base logo as the featured node"
---

Coinbase launched tokenized stocks on Base on 2026-08-24, and they are listed on Ophis from day one. Open [swap.ophis.fi/#/8453/swap/USDC/AAPLc](https://swap.ophis.fi/#/8453/swap/USDC/AAPLc), connect a wallet, and sign an EIP-712 order: no settlement transaction to broadcast, no settlement gas to pay, and a signed limit price that is the worst execution you can receive. The tokens are Base-native B20 assets issued by Coinbase; per [Coinbase's own description](https://www.base.org/stocks), each token is a beneficial claim on a real share, backed 1:1 and held in regulated, bankruptcy-remote custody separate from Coinbase. Ophis ships its own token list for them, shows a stock panel next to the quote with the corporate-action multiplier and pause state read from the Base contracts, and routes the order through CoW Protocol's batch auction on Base.

Two sentences of context. Base is chain id 8453, an OP-Stack L2 operated by Coinbase, and one of the 13 EVM chains [Ophis](https://ophis.fi/) supports. Ophis is an intent-based DEX aggregator, a fork of [CoW Protocol](https://docs.cow.fi)'s frontend with a natural-language intent layer and an agent stack on top; on Base it settles through CoW Protocol's hosted orderbook and solver network, so the stock tokens inherit the same MEV protection as every other token on the chain.

## Swap a tokenized stock on Base, step by step

1. **Open the app pinned to Base and the pair.** `https://swap.ophis.fi/#/8453/swap/USDC/AAPLc` loads the swap form with USDC on the sell side and AAPLc on the buy side. Replace the symbol with any other listed stock, for example `NVDAc`, `METAc` or `GOOGLc`.

2. **Connect your wallet.** Ophis is self-custodial. It never holds your funds, and nothing moves without a signature from your wallet (EIP-712 for regular accounts, ERC-1271 for smart-contract accounts).

3. **Pick the stock from the list, or type it.** For visitors in eligible jurisdictions outside the U.S., the Base token selector carries every Coinbase stock with its on-chain symbol, the issuer's logo where Coinbase has published one, and a "Coinbase stock" badge. Search by ticker or company name. Ophis never asks you to paste a contract address for these tokens, which is the point: a token that merely calls itself AAPL is not on that list. Visitors identified as being in the U.S. see a curated Base list instead, which does not include these tokens, consistent with Coinbase's eligibility terms.

4. **Read the stock panel.** As soon as a Coinbase stock is on either side of the pair, the swap form shows a panel specific to it: the corporate-action multiplier, whether transfers are paused on chain, whether Coinbase has minted supply yet, and the issuer's eligibility statement. The panel is advisory: it sits next to the quote and says so when its data is unavailable, and it never blocks or alters an order. More on what each of those means below.

5. **Review the quote and sign.** The quote carries a hard limit price, and that limit is what you sign: the worst execution you can receive. Your wallet shows typed data, not a transaction. Orders are gasless, and the fee comes out of the traded amount rather than being billed separately.

6. **Wait for settlement.** Solvers race to fill the order against Base liquidity and the winner settles it on-chain in a batch. Order status updates on the page until the trade lands.

At the time of writing, 100 USDC quotes about 0.32 AAPLc, with the token trading near the underlying's 312 USD close, and the deepest pools are the AAPLc/USDC and NVDAc/USDC Aerodrome pools at roughly 650,000 and 950,000 USD of liquidity. Those numbers will be stale by the time you read this; the quote on the page is the one that counts.

## What a Coinbase tokenized stock is

Coinbase issues these tokens under [B20](https://docs.base.org/base-chain/specs/upgrades/beryl/b20), a Base-native token standard that extends ERC-20. The full integration reference is on [docs.base.org](https://docs.base.org/base-chain/asset-issuance/tokenized-stocks-on-base), and the product page is [coinbase.com/tokenize](https://coinbase.com/tokenize). The properties that matter when you trade them:

| Property | Value |
| --- | --- |
| Chain | Base (chain id 8453) |
| Standard | B20, an ERC-20 extension implemented as a Base-native precompile |
| Issuer | Coinbase |
| Backing | Per Coinbase: a 1:1 claim on a real share, held in regulated, bankruptcy-remote custody separate from Coinbase ([source](https://www.base.org/stocks)) |
| Decimals | 8 |
| Symbols | The ticker plus a lowercase `c`: `AAPLc`, `NVDAc`, `METAc`, `GOOGLc` |
| Secondary trading | Permissionless, 24/7 on Base DEXs |
| Mint and redeem | Restricted to Coinbase's authorized participants, who complete KYC |
| Onchain price feeds | Chainlink, 24/5, total-return values that include corporate actions |
| Eligibility | Available only to persons in eligible jurisdictions outside the U.S. |

One detail is invisible in the app but worth knowing: these tokens have no bytecode. B20 tokens are native precompiles, so every Coinbase stock shares the same implementation that Base shipped in its Beryl upgrade, audited by Base and Spearbit, rather than a per-asset contract you would verify on Basescan. The ERC-20 surface, `permit`, the multiplier and pause views all answer normally, which is why the tokens work through Ophis without any special handling at settlement.

### The thirteen tokens

Thirteen stocks are deployed. Four had supply minted on launch day; the rest exist on chain with zero supply. Ophis lists all thirteen, so once Coinbase mints one and a DEX pool holds usable liquidity for it, solvers can quote it without Ophis shipping anything new.

| Token | Company | Address on Base |
| --- | --- | --- |
| AAPLc | Apple Inc. | `0xb200000000000000000000C2e324d24d7eEcd1fb` |
| GOOGLc | Alphabet Inc. | `0xb2000000000000000000002D0BA3164cc74f58B7` |
| METAc | Meta Platforms Inc. | `0xb2000000000000000000008bC8786B856E61707C` |
| NVDAc | NVIDIA Corporation | `0xb20000000000000000000078ee7ce2fE4908108C` |
| AMZNc | Amazon.com Inc. | `0xb200000000000000000000d9192b6B456483C2E8` |
| COINc | Coinbase Global Inc. | `0xb200000000000000000000c85a31389D71F3ecfb` |
| CRCLc | Circle Internet Group Inc. | `0xB20000000000000000000019f6E7C675b73C2e4D` |
| INTCc | Intel Corporation | `0xB2000000000000000000004AFF16039bA04bdFBc` |
| MSFTc | Microsoft Corporation | `0xB200000000000000000000Ab99cFa739E253872B` |
| MSTRc | Strategy Inc. | `0xb2000000000000000000004884b426556b92883d` |
| SNDKc | Sandisk Corporation | `0xb200000000000000000000397293Cb8cda9a10c5` |
| SPCXc | Space Exploration Technologies Corp. | `0xb2000000000000000000007b9fcbd005511aCBd5` |
| TSLAc | Tesla Inc. | `0xb2000000000000000000001e800a7f5189430cD0` |

The first four are the ones with supply on launch day. Every address above carries the `0xb2000000…` prefix because it comes from the B20 factory, and so do unrelated tokens created through the same factory, so the prefix proves nothing on its own. Ophis identifies these tokens by their exact address, never by prefix or symbol, and the current list is served at [swap.ophis.fi/token-lists/coinbase-tokenized-stocks.json](https://swap.ophis.fi/token-lists/coinbase-tokenized-stocks.json).

## One token is not always one share

A B20 stock token carries a multiplier. When the underlying pays a dividend or splits, the redemption ratio changes and the multiplier moves with it: after a dividend the multiplier might read 1.02, meaning one token is redeemable for 1.02 shares. Balances never rebase. Cash dividends on these tokens are converted into shares and reflected the same way, so your token count stays put while what each token represents grows. The Chainlink feed for each stock is total-return for the same reason: a 10:1 split drops the underlying price ten times and lifts the multiplier ten times, and the token's price does not jump.

On launch day every multiplier reads exactly 1, so the distinction never surfaces. It will. Read the value on the panel rather than assuming it is 1, especially before comparing a token's DEX price to the equity's quote.

## What Ophis shows next to the quote

Ophis added a Base-specific stock panel beside the quote, the same way it did for stock tokens on Robinhood Chain. It informs the trade; it does not gate it.

**It confirms the token is one Coinbase issued.** The token list Ophis ships for Base was built from the addresses in Base's own documentation, and each entry's name, symbol, decimals and logo were read from the token's on-chain `name()`, `symbol()`, `decimals()` and `contractURI()` rather than typed by hand. That list wins over every other list Ophis loads on Base, so a search for "AAPL" surfaces `AAPLc` with Apple's logo, and the "Coinbase stock" badge is only ever attached through that list. A user-added list cannot spoof it.

**It reads the multiplier from the chain.** The panel calls each token's `multiplier()` view on Base and shows the factor next to the symbol. If you are selling, it also converts your balance: at a multiplier of 1.02, a balance of 10 AAPLc is shown as representing about 10.2 underlying shares.

**It surfaces pauses and unissued supply.** B20 lets the issuer pause transfers per feature. The panel calls `pausedFeatures()` and switches to an attention state if transfers are paused for a token in your pair. It also reads `totalSupply()`: a token that Coinbase has listed but not yet minted shows as "not issued yet", with a note that quotes will return no liquidity until supply exists. That is the state the nine unminted tickers are in at the time of writing.

**It fails visibly, not silently.** The panel's data comes from a same-origin endpoint, [swap.ophis.fi/api/base/tokenized-stocks](https://swap.ophis.fi/api/base/tokenized-stocks), that batches the three views for all thirteen tokens against Base and caches the result at the edge for five minutes. Every value is re-validated before it is served, a failed read is a 502 rather than a partial payload, and there is no stale-while-revalidate window, so an old snapshot is never served as a fresh one. If the endpoint cannot be reached, or a background refresh fails, the panel says the metadata is temporarily unavailable and leaves quoting and signing available so you can decide; it does not hold your order until a read succeeds. Whatever the panel reports, the executable price is always the solver quote.

**It states the issuer's eligibility.** Coinbase tokenized stocks are only available to persons in eligible jurisdictions outside the U.S. The panel carries that statement on every stock pair. Ophis is a non-custodial interface: it does not hold the tokens, mint them, or redeem them.

## Fees and rebates on Base

Base is one of the ten chains where Ophis settles through CoW Protocol's hosted stack rather than its own. Every trade pays the 1 bp Ophis base fee, and Ophis retains 80% of reference-quote improvement on volatile pairs, capped at 99 bps of volume, or 50% on stablecoin pairs, capped at 20 bps; the trader receives the remainder and everything above the cap. CoW Protocol charges its own upstream volume fee on hosted chains, 0.02% on volatile pairs and 0.003% on correlated ones, which Ophis does not receive. A stock-token swap against USDC is a volatile pair, so the all-in fixed cost is 0.03%. The [fee docs](https://docs.ophis.fi/fees) carry the full breakdown per chain type.

Rolling 30-day volume then places you in a rebate tier. The percentage is a weight, not a refund of your own fee: each month, a pool of 21.25% of the WETH fees Ophis collected is split across eligible wallets in proportion to their 30-day volume multiplied by their tier weight.

| Tier | 30-day volume | Rebate |
| --- | --- | --- |
| Bronze | $20,000+ | 10% |
| Silver | $50,000+ | 15% |
| Gold | $100,000+ | 25% |
| Palladium | $500,000+ | 35% |
| Platinum | $1,000,000+ | 50% |

Rebates are paid monthly in WETH from the fee Safe. What a wallet receives depends on the pool and on every other eligible wallet's weighted volume that month. Your tier and progress show on the swap page, and the [fee docs](https://docs.ophis.fi/fees) carry the full mechanics.

## Coinbase stocks on Base and Robinhood Stock Tokens: two different products

Ophis now lists two different kinds of equity-linked token from two issuers on two chains, and they are not interchangeable.

| | Coinbase Tokenized Stocks | Robinhood Stock Tokens |
| --- | --- | --- |
| Chain | Base (8453) | Robinhood Chain (4663) |
| Standard | B20, Base-native precompile | ERC-20 with an issuer registry |
| Where Ophis settles | CoW Protocol's hosted GPv2 on Base | Ophis-operated sovereign GPv2 |
| Multiplier source | Read from the token contract | Read from Robinhood's asset registry |
| Trading hours | 24/7 on Base DEXs | Per session, with restrictions published per asset |
| Ophis fee | 1 bp base plus capped improvement, plus CoW's upstream fee | 1 bp base plus capped improvement, no upstream fee |

An `AAPLc` on Base and an `AAPL` Stock Token on Robinhood Chain both track Apple, but they are different tokens from different issuers with different redemption terms. Ophis does not bridge one into the other. If you want the Robinhood side, read [how Ophis runs on Robinhood Chain](/blog/swap-on-robinhood-chain/). Ophis is an independent protocol and is not affiliated with, endorsed by, or officially connected with Robinhood Markets, Inc.

## Building with these tokens

Everything the app uses is public and keyless.

- **Token list.** [swap.ophis.fi/token-lists/coinbase-tokenized-stocks.json](https://swap.ophis.fi/token-lists/coinbase-tokenized-stocks.json) is a standard Uniswap-schema list with CORS enabled, so any interface can load it. Identify tokens by address; B20 names and symbols are mutable on chain.
- **Metadata endpoint.** [swap.ophis.fi/api/base/tokenized-stocks](https://swap.ophis.fi/api/base/tokenized-stocks) returns, per token, the multiplier as an 18-decimal string, whether supply is issued, and whether transfers are paused.
- **MCP server.** [`https://mcp.ophis.fi/mcp`](https://mcp.ophis.fi/mcp) is keyless and unauthenticated. On Base, `resolve_token` consults the Coinbase stock list first, then CoW's list, so `AAPLc` or `NVDAc` resolves to the same canonical address the selector shows, with decimals and the list it came from; a symbol that is not on a trusted list returns no canonical rather than a guess. `build_order` returns a bounded order with the receiver pinned to the owner, and the server never holds keys and never signs. The [agent walkthrough](/blog/let-an-ai-agent-swap-tokens/) covers the safety model.
- **SDK.** `@ophis/sdk` resolves the orderbook URL and the EIP-712 signing domain per chain; on Base that is CoW Protocol's canonical settlement domain.
- **Widget.** `@ophis/widget-react` embeds the swap form directly. See the [widget docs](https://docs.ophis.fi/widget).

## FAQ

### Can I buy Coinbase tokenized stocks on Ophis?

Yes. Ophis lists all thirteen Coinbase tokenized stocks on Base, with AAPLc, GOOGLc, METAc and NVDAc tradable from launch day and the other nine listed ahead of their first mint. Open [swap.ophis.fi/#/8453/swap/USDC/AAPLc](https://swap.ophis.fi/#/8453/swap/USDC/AAPLc), connect a wallet, and sign an EIP-712 order. Coinbase states that its tokenized stocks are only available to persons in eligible jurisdictions outside the U.S.

### Do I need ETH on Base to pay gas?

Not for the order itself. Orders are gasless: you sign an EIP-712 typed-data message rather than broadcasting a transaction, the winning solver pays the settlement gas, and the Ophis fee is deducted from the traded amount rather than charged separately. Selling a token for the first time normally needs a one-time on-chain approval, which costs a small amount of ETH on Base. Regular wallets can replace that approval with a gas-free permit signature on tokens that support it, and the minted Coinbase stocks do; smart-contract accounts still send the approval transaction.

### Why does a stock show "not issued yet" or return no liquidity?

Coinbase deployed thirteen tokens but minted supply for four on launch day. A token with zero supply has no pools to trade in, so a quote returns no liquidity and the Ophis panel labels it as not issued yet. Ophis lists the token anyway: once Coinbase mints supply and a DEX pool holds usable liquidity for it, solvers can quote it without waiting for a new Ophis release. Minting alone does not create liquidity.

### What does the corporate-action multiplier mean?

One B20 token does not permanently equal one share. When the underlying pays a dividend or splits, Coinbase updates the token's multiplier instead of changing balances, so a multiplier of 1.02 means one token is redeemable for 1.02 shares. Ophis reads the multiplier from the token contract on Base and shows it on the swap form, along with the share equivalent of the balance you are selling.

### Are these the same as the Stock Tokens on Robinhood Chain?

No. Coinbase tokenized stocks are B20 tokens on Base issued by Coinbase; Robinhood Stock Tokens are ERC-20s on Robinhood Chain issued by Robinhood. They track the same companies but have different issuers, redemption terms, trading hours and settlement paths, and Ophis does not convert one into the other.

### How much does a tokenized stock swap cost on Ophis?

On Base, Ophis charges a 1 bp base fee plus 80% of reference-quote improvement on volatile pairs, capped at 99 bps of volume. CoW Protocol adds its own upstream volume fee of 0.02% on volatile pairs, so the all-in fixed cost of a stock-token swap against USDC is 0.03%. Rolling 30-day volume places you in a rebate tier whose weight sets your share of a monthly pool of 21.25% of collected WETH fees.

## Start swapping

Open [swap.ophis.fi/#/8453/swap/USDC/AAPLc](https://swap.ophis.fi/#/8453/swap/USDC/AAPLc), connect a wallet, and sign your first Coinbase stock order on Base. ERC-20 settlement is gasless, the signed limit is enforced, and the stock panel shows the multiplier and pause state read from the chain next to your quote. If you are integrating rather than trading, start from the [getting-started guide](https://docs.ophis.fi/getting-started) and load the Coinbase token list from its public URL.
