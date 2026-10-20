# PropAMM liquidity, checked 20 October 2026

Implementation on `feat/liquidity-addons-20261020`, based on `7523bc73`.
No deployment, transaction submission or upstream registration was performed.
See the [follow-up audit](../audits/2026-10-20-liquidity-addons-review.md) for
review corrections, added settlement tests and verification limits.

## Where a connector can participate

`packages/sdk/src/orderbook.ts` sends Optimism (10), Unichain (130), Robinhood
(4663) and Arc (5042) to Ophis-operated orderbooks. Ethereum, Gnosis,
Arbitrum, Base, Polygon, Avalanche, BNB, Linea, Plasma and Ink use CoW-hosted
orderbooks. A local Ophis driver configuration cannot register a solver with
CoW's hosted auction infrastructure; that needs CoW solver onboarding and
chain-specific settlement authorization. The existing aggregator solvers can
already reach some PMMs indirectly, depending on the actual route returned.

Solana and the additional destination networks in the transfer UI use separate
transfer/intent providers. They are not sovereign GPv2 orderbooks. Adding an
EVM interaction cannot add liquidity to their execution engines.

## Sources found and integration disposition

| Source | Supported-chain intersection / evidence | Ophis disposition |
| --- | --- | --- |
| WOOFi sPMM | Optimism, Arbitrum, Avalanche, BNB, Polygon, Linea, Base in the official EVM guide | Direct Optimism lane already exists, including driver validation and auction/quote wiring. Retain it. Other intersections are hosted chains. |
| DODO PMM | Official pool factories include Optimism, Ethereum, BNB, Polygon, Arbitrum | Existing DODO **aggregator** lanes on OP and Unichain; this does not imply DODO PMM pools exist on Unichain. No duplicate aggregator is added. |
| Metric v1 | Public API reports Ethereum, BNB and Robinhood. Robinhood metadata returned 41 funded pools; all 41 pool factory/token triples were independently checked with `getImmutables()` | New direct Robinhood lane, initially restricted to nine reviewed green pools, with locally encoded router calls and independent driver checks. New pools need review before being pinned. |
| ElfomoFi | Official integration guide lists Base, BNB and Robinhood; Robinhood `getSupportedPairs()` returned ten pairs and WETH/USDG quoted successfully | New direct Robinhood lane using `getAmountOut` and the standard approval-based `swap`, with partnerId zero. No callback or prefunding path. |
| Native pAMM / Native Relay | V6 deployment docs include Ethereum, BNB, Arbitrum, Base and Robinhood; direct pAMM documentation lists BNB engines, with no engines assigned to the other V6 chains at its snapshot | Robinhood WETH/USDG `getEngine` returned zero. Do not treat a deployed router as usable pAMM liquidity. RFQ access is a separate signed-quote integration. |
| LunarBase | Current repository lists native ETH/USDC on Base and native BNB/USDT on BNB | Hosted-chain candidate. Current README supersedes the stale search-index excerpt describing a BNB-only v0.4.0 ABI. Preserve native-token semantics; no guessed Robinhood address. |
| Biconomy PropAMM | Current repository publishes Base and Base Sepolia addresses | Hosted-chain candidate. Push-payment swap requires an atomic funding-and-swap path, not the protected single-interaction grammar. No sovereign deployment is established by these records. |
| Tessera, BinaryFi, st0x propAMM hook | 0x's source additions establish Base integrations; BNB's ecosystem documentation also identifies Tessera | Hosted-chain candidates. Source names are discovery evidence, not authenticated targets/ABIs for a new local driver allowlist. |
| Fermi, Metric, Bebop, Kipseli, Tempest, ElZorro, Stelaxis, TaurusFi, Goliath | Titan's Ethereum taker documentation publishes streams and quote helpers for these makers | Ethereum candidate set. Fresh maker state can require access approval; builder-aware simulation/submission and CoW solver participation must be arranged before enabling a direct lane. A historical public-RPC quote is insufficient. |
| Hashflow; Clipper FMM | Hashflow publishes deployments including OP, Ethereum, Arbitrum, Polygon, BNB, Avalanche and Base; Clipper lists OP, Ethereum, Polygon, Arbitrum and Base | Signed RFQ integrations, distinct from permissionless oracle quoting. Clipper explicitly requires API credentials. Existing code deliberately disables RFQs in some aggregator lanes; removing that protection needs execution-lifetime and taker-binding work. |
| SolFi / SolFi V2, HumidiFi, GoonFi V2, TesseraV, BisonFi, ZeroFi, AlphaQ, Aquifer, Obric V2 | Jupiter's live program-id label response lists these Solana sources | These require the Solana/transfer provider's routing engine. An EVM GPv2 solver cannot execute their programs. |

No additional directly usable deployment on Unichain or Arc was established
from the reviewed primary records. This is a bounded discovery result, not
a claim that no private or newly deployed PMM exists there.

## Execution checks

Both new lanes support exact-input SELL orders and settle output directly to
Robinhood Settlement. They use raw integer token units, bounded allowances,
positive output floors and strict output simulation. The driver requires one
fulfillment and one protected interaction and rejects unrelated selectors,
recipients, fee helpers, approvals, tokens and amounts. Metric additionally
binds the reviewed pool and direction; its router treats `tokenOut` as
informational, so a router-address allowlist alone would be insufficient.

Metric's extension-aware quoter must use the router as pool sender and
Settlement as recipient; the RPC call omits `from`. Onchain pool immutables
come from `getImmutables()`, not ERC-20-style `token0()` getters.

Fork checks at Robinhood block 93,311,122 execute both directions from the real
Settlement address. Metric also checks impossible-output and expired calls;
Elfomo checks impossible output. These are local fork transactions, not live
settlements. Elfomo's fork test supplies the real block-pinned `arbBlockNumber`
response because Foundry does not implement Nitro's ArbSys precompile. That
substitution must not be described as a full Nitro execution test.

The local service configurations include compose, startup/restart lists,
driver, autopilot auction dispatch, orderbook/autopilot quote lists and the
frontend solver registry. Config rendering uses the existing glob-based
renderer and the internal supervised RPC URL. No secret files were rendered.

The shared driver fulfillment check now converts native token addresses to
the configured wrapped token before looking up clearing prices and binding
router inputs/outputs. This fixes native ETH buys for protected direct routes;
the driver retains the normal settlement unwrap. Its regression also rejects
a native-sentinel price when the required wrapped-token price is missing.

Verification passed: five fork tests; live Rust quotes in both directions for
both venues and identity checks for all nine pinned Metric pools; four shared
Metric tests; targeted solver/driver mutation and fulfillment tests; five RPC
tests; 21 frontend registry tests; the orderbook path label test; and registry,
TOML and compose security checks. Frontend lint passed with the existing
missing-Nx-project-graph warning. Full application builds and a complete local
GPv2 auction/settlement stack were not run. The pinned fork tests require
archive state once the public RPC prunes block 93,311,122.

## Primary references

- [WOOFi EVM integration](https://learn.woo.org/woofi-docs/woofi-dev-docs/guides)
- [DODO pool discovery](https://docs.dodoex.io/en/developer/data/how-to-find-all-the-dodo-pools)
- [Metric deployments](https://docs.metric.xyz/reference/supported-chains-and-deployments)
- [Metric pool metadata](https://api.metric.xyz/public/v1/evm/4663/metadata?count=500&contract_version=v1)
- [Metric quoting](https://docs.metric.xyz/reference/smart-contracts/get-quote)
- [Metric router](https://docs.metric.xyz/reference/smart-contracts/swapping-via-router)
- [Metric pool source](https://github.com/Metricxyz/pool-contracts)
- [ElfomoFi integration](https://docs.elfomo.fi/integration)
- [Native pAMM deployments](https://docs.native.org/native-dev/build-with-native/swap-aggregators/pamm-swap-apis/addresses)
- [Native current routers](https://docs.native.org/native-dev/resources/addresses)
- [LunarBase integration repository](https://github.com/Lunarbase-Lab/LunarBaseIntegrations)
- [Biconomy PropAMM](https://github.com/bcnmy/propamm-protocol-docs)
- [0x source additions](https://docs.0x.org/changelog)
- [BNB market-making landscape](https://www.bnbchain.org/en/blog/bnb-chain-market-making-landscape-liquidity-venues-how-to-integrate)
- [Titan taker interface](https://docs.titanbuilder.xyz/propamms/takers)
- [Hashflow deployments and RFQ](https://docs.hashflow.com/hashflow/market-making/getting-started-api-v3)
- [Clipper RFQ](https://docs.clipper.exchange/disclaimers-and-technical/integrating-with-clipper-rfq/guides/how-to-use-clipper-rfq-api)
- [Jupiter program labels](https://api.jup.ag/swap/v1/program-id-to-label)

Local raw responses, fork logs, Claude review and Jev claim checks are stored
separately in `/Users/scep/ophis-addon-evidence/01-propamms/`. Jev rejected the
stale LunarBase claim; the inventory uses the current fetched repository text.
Model judgments supplement source and execution checks; they do not authorize
contracts or prove successful settlement.
