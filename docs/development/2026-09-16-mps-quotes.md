# MPS small-swap investigation — 2026-09-16

## Findings

The production Ethereum sell quote returned `buyAmount: "0"` for 0.0033 ETH before frontend fees or slippage. The orderbook quotes the full input, then proportionally scales the already-integer output down to reserve network fees (`Quote::with_scaled_sell_amount`, `apps/backend/crates/shared/src/order_quoting.rs`). Any positive fee turns an output of one indivisible token into zero. Larger orders can lose an additional whole token too.

Ethereum quotes come from `https://api.cow.fi/mainnet/api/v1/quote`, not Ophis's own-chain backend. Merely changing the local Rust backend would not fix this partner's Ethereum widget.

The API's existing `sellAmountAfterFee` request returns a real, identified quote for the input after reserving fees, avoiding that extra rounding step. The frontend now requests this for optimal same-chain sell quotes into zero-decimal tokens, checks the all-in signed spend against the user's original budget, and keeps the better quote with its original SDK signing callback. An unchanged output at a lower spend also qualifies. The signed minimum must not deteriorate. A fee increase triggers a smaller-input retry, reserving 1% of the new fee against estimate jitter; this reserve remains unspent. At most three additional requests are made; failures retain the original quote. Fast previews and other token/order flows are unchanged.

## Quote comparison

Live HTTP quotes were obtained close together, but cannot be pinned to an Ethereum block. Uniswap QuoterV2 calls below were pinned to block 25990334. Market and gas estimates change. CoW amounts include the settlement fee inside the input budget; Uniswap output excludes the transaction gas paid separately. These are **not all-in execution-cost equivalents**.

| ETH budget | Original CoW MPS | Fee-exclusive CoW MPS | CoW total ETH including fee | Uniswap direct v3 MPS, excluding gas |
| --- | ---: | ---: | ---: | ---: |
| 0.0033 | 0 | 1 | 0.002983118717 | 1 |
| 0.005 | 1 | 1 | 0.004991006851 | 2 |
| 0.01 | 3 | 4 | 0.009693823391 | 4 |
| 0.05 | 20 | 21 | 0.049861299534 | 21 |
| 0.1 | 42 | 42 | 0.099994864682 | 42 |

At 0.005 ETH, CoW's fee reservation still leaves less than the input needed for two MPS, while the Uniswap swap alone returns two. This fix removes avoidable rounding loss; it does not eliminate the execution-cost difference between batch settlement and a direct AMM transaction. A complete cheapest-execution comparison would need direct-route execution integrated into Ethereum alongside CoW, including gas, approvals, and native-token handling.

At the pinned block, the three checked routes to buy exactly 1 MPS (AMM input, excluding gas) were:

- MPS/WETH Uniswap v3, 1% fee, `0x216CC6E30BE12b91982f17C9009C36D09fE6f522`: 0.002261983382109656 ETH.
- WETH/USDC v3 → MPS/USDC v2, `0xcD6F65A972551FFaC9B52Fa2D4a561D9b7AB4741`: 0.002263239766221559 ETH.
- WETH/USDC v3 → MPS/USDC v3, `0xa74ac034f5D255d19C0Fae3E30a51f8482E20a91`: 0.002341617019216276 ETH.

The v3 factory returned no direct MPS/WETH pools at 0.01%, 0.05%, or 0.3%; the 1% pool exists. The CoW exact-buy quote requested alongside these checks returned 0.002262531520470353 ETH before its 0.000478708421375356 ETH settlement fee: a pool price close to the best Uniswap route. Uniswap's web application did not load in the automated browser (HTTP 409 responses), so these comparisons use its deployed quoter and pool reserves rather than its UI.

A separate Gnosis native-token probe for 8 xDAI → MPS returned `NoLiquidity`. The Ethereum result must not be represented as proof that Gnosis routing is working.

## Slippage

The observed market service returned 233 bps. The SDK adds an allowance equal to half the quoted network fee relative to the input, explaining much larger dynamic percentages on small trades. This is separate from the zero-output bug.

The actual sell-order formula is `minimum = netBuy - floor(netBuy * slippageBps / 10000)`. For 1 MPS and 18.77%, the signed minimum remains **1**, not zero. Tests cover this with partner and protocol fees. The change preserves the existing slippage calculation and user settings; it does not increase tolerance or invent fractional MPS. The displayed percentage can consequently exceed the effective whole-token loss allowed by the signed limit.

## Logo

Both existing fallback URLs failed for Ethereum MPS. Bundled the official [Mt Pelerin brand asset](https://www.mtpelerin.com/images/mps-icon.svg) from its [brand page](https://www.mtpelerin.com/brand), mapped by chain and address for Ethereum and Gnosis. Verified the SVG loads in the mobile browser. The [partner token page](https://www.mtpelerin.com/shareholders) verifies both contract addresses.

## Verification

- 47 targeted Jest checks pass across quote recovery, quote polling, receive-amount calculations, and token logos.
- Frontend TypeScript check passes; targeted ESLint and `git diff --check` pass.
- Local browser, 390×844: entering 0.0033 ETH displays 1 MPS and the bundled logo.
- Live SDK quote with production settlement domain `0x9008D19f58AAbD9eD0D60971565AA8510560ab41`: quote 1328894061, verified by upstream, unsigned order spends 0.00303254577451122 ETH and requires 1 MPS, within the 0.0033 ETH budget. This check includes a 51-bps partner-fee configuration. No order was signed, posted, or settled.
- Read-only evidence: `/private/tmp/ophis-mps-benchmark.json`, `/private/tmp/ophis-mps-sdk-proof.json`, `/private/tmp/ophis-mps-mobile-after.png`. These checks used local source against live APIs before deployment.

Uniswap deployment addresses: [official Ethereum deployment reference](https://developers.uniswap.org/docs/protocols/v3/deployments/v3-ethereum-deployments).
