# Phase-C oracle sizing: `maxDivergenceBps` and the CAPO growth ceilings

Fact-based derivation of the two open sizing parameters from the Phase-C design
spec (`2026-07-20-vault-policy-phase-c-design.md`). Requirement set by Clement
(2026-08-02): every number proven from primary or authoritative sources - no
guessed data. Anything that could not be traced to such a source is labeled
UNVERIFIED and excluded from the derivation. Both parameters are per-token
`TokenAdd` fields behind the P3 timelock. The misconfiguration asymmetry is
stated honestly, because it is NOT symmetric: a value set TOO TIGHT fails
closed (reverted reads, blocked trades - an availability incident); a value
set TOO LOOSE silently WEAKENS the check - an oversized `maxDivergenceBps`
accepts a faulty route/anchor discrepancy and an oversized growth ceiling
accepts abnormal rate inflation, and the bad value then flows into the floor.
That loosening direction is exactly why both parameters live behind the
timelock with a per-listing review, and why the class defaults below are
derived tight-side-of-defensible rather than generous. What our
reverts-not-clamps posture (C18) does buy: a TIGHT misconfiguration can never
reprice collateral the way a price-capping design can (Aave, 2026-03-10: a
CAPO snapshot misconfiguration capped wstETH/ETH at ~1.1939 vs ~1.228 market
and caused ~$27M of wrongful liquidations;
coindesk.com/business/2026/03/10/defi-lending-platform-aave-sees-a-rare-usd27-million-liquidations-after-a-price-glitch)
- with us the same mistake is downtime. The loose direction has no such
shield anywhere; only review does.

## A. `maxDivergenceBps` - how far may route and anchor legitimately disagree?

### A.1 The mechanical noise floor: feed deviation thresholds (primary: Chainlink RDD)

Deviation threshold + heartbeat per relevant feed, read 2026-08-02 from
Chainlink's reference data directory
(`reference-data-directory.vercel.app/feeds-*.json` - the machine-readable
source behind docs.chain.link):

| Feed | Chain | Deviation | Heartbeat |
|---|---|---|---|
| WSTETH/STETH Exchange Rate | Unichain | 0.05% | 24h |
| WEETH/EETH, EZETH/ETH, RSETH/ETH Exchange Rate | Unichain | 0.05% | 24h |
| ETH/USD | Unichain | 0.5% | 24h |
| ETH/USD | Optimism, Base | 0.15% | 20 min |
| ETH/USD | Ethereum | 0.5% | 1h |
| ETH/USD | Arbitrum | 0.05% | 24h |
| rETH-ETH Exchange Rate | Optimism, Arbitrum | 0.2% | 24h |
| rETH/ETH Exchange Rate | Base | 1e-7 (update-on-change) | 24h |
| weETH/eETH, ezETH/ETH, rsETH/ETH Exchange Rate | OP/Base/Arb (typ.) | 0.5% | 24h |
| RETH/ETH, weETH/ETH, ezETH/ETH (market feeds) | Ethereum/L2s | 0.5% | 24h |
| STETH/ETH (market) | Ethereum | 0.5% | 24h |
| CBETH/ETH (market) | Ethereum | 1% | 24h |
| tETH/wstETH Exchange Rate | Ethereum, Arbitrum | 0.02% | 24h |

Two feeds can sit apart by up to the SUM of their deviation thresholds without
either being stale or wrong (each only promises to update when it drifts past
its own threshold; Gauntlet documented the resulting ~2-minute update desyncs
between correlated feeds as the motivation for synchronized adapters:
governance.aave.com/t/arfc-gauntlet-and-bgd-chainlink-synchronicity-price-adapter-2-0/13046).
For the standard 0.5% + 0.5% pairing the mechanical noise floor is **100 bps**.

**Denominator cancellation is MANDATORY for any route claiming a class
default, not a nicety** - measured, not asserted: the desynchronization
exposure of a NON-cancelling comparison (route and anchor each carrying
their own USD leg, updating ~2 minutes apart per the Gauntlet observation)
is the underlying's move across that lag. Computed from 30 days of Binance
ETHUSDT 1-minute closes (43,200 candles, read 2026-08-02; method in the
research log): 2-minute absolute ETH moves reach p99 29.2 bps, p99.9 55.1
bps, p99.99 107.6 bps, max 164.3 bps. A side-by-side USD comparison
therefore sees desync excursions ABOVE any sane band several times a month
- it is unclassifiable, and gets only a per-route derivation built on those
measured statistics. A CANCELLED comparison (ratio vs ratio in ETH terms -
the spec's composed-anchor rule) removes the USD leg entirely; the compared
LST ratios move ~3%/yr, so their 2-minute drift is negligible and the
desync term collapses.

**The margins, each sourced or labeled:** basis envelope **15 bps** = 3x the
worst measured calm-market basis (4.0 bps, A.2; the 3x is a labeled safety
factor), plus **10 bps** desync-and-jitter allowance for market-feed ratio
movement inside the update lag (labeled allowance - the measured ExR-side
drift is ~0, this covers the market-feed side). Total margins: 25 bps. The
earlier draft's 20+30 split was flagged in review as unsourced and is
withdrawn.

### A.2 The steady-state basis (measured, primary)

Market price vs on-chain exchange rate, measured 2026-08-02 (CoinGecko
aggregate vs `eth_call` on the token contracts): wstETH **-0.5 bps**, rETH
**+4.0 bps**, stETH **-1.3 bps**. Calm-market basis is single-digit bps,
inside a +/-20 bps envelope. (Method + addresses in the research log,
memory topic `2026-08-02`; contracts `0x7f39C581...` `stEthPerToken`,
`0xae78736C...` `getExchangeRate`.)

### A.3 Stress magnitudes the band must react to (sourced)

| Event | Max market-vs-rate divergence | Duration | Source |
|---|---|---|---|
| stETH, Jun 2022 | 6-7% (prints to 0.93) | ~5 months below peg | trustnodes.com 2022/06/13, protos.com steth-peg, coinmetrics SOTN #250; an "8%" figure circulates but is UNVERIFIED |
| cbETH, Aug 2022 (pre-withdrawals) | ~8% | weeks | coindesk.com First Mover 2022/08/26 |
| ezETH, Apr 2024 | ~2.9% market-wide (pool wicks to -75% are thin-liquidity artifacts) | hours | cointelegraph.com renzo-ezeth-depegs-688-airdrop |
| rsETH, Apr 2024 | -1.5% | "quickly corrected" | research.llamarisk.com collateral-risk-rseth |
| Fast-crash transient (no depeg) | 11.76% momentary (wstETH -23% vs ETH -21%) | minutes | blockanalitica.substack.com exchange-rate-oracles-for-liquid, Aug 5 2024 |

The Block Analitica observation matters for DESIGN validation, not the number:
during a fast crash the band WILL trip without any depeg. Under our
direction-aware rule, buys of the volatile asset revert, and exits validate
at the conservative anchor-low price - PROVIDED the anchor is the low side
and still inside the persisted `[sanityLow, sanityHigh]`; below `sanityLow`
even the exit reverts (the band is never pierced; normative rule in the
Phase-C spec). Sizing the rail correctly requires being explicit about WHAT
it bounds: the spec's sanity band constrains the ABSOLUTE composed price -
for a USD-composed route that includes every legitimate market move of the
underlying, not just route/anchor disagreement. A rail fixed relative to the
LISTING-TIME price therefore must survive real market drawdowns between
recalibrations, or ordinary volatility freezes the route (including its
exits) with both feeds agreeing. The bounding facts are PER ASSET
- a rail derived from ETH's history alone does not transfer to the other
market underlyings the catalog admits (BTC, LINK, UNI direct routes), and
the CEILING needs its own measurement (bull-run up-moves pierce a
symmetric x5 for every asset in the record). Computed from primary data
(Binance daily klines, full listed history per symbol to 2026-08-02;
both bases reported because the wick basis is single-venue-artifact
sensitive; method in the research log):

| Asset (history from) | Worst 90d down close/wick | Worst 90d up close/wick | Worst 120d down close/wick | Worst 120d up close/wick |
|---|---|---|---|---|
| ETH (2017-08) | -73.4% / -75.0% | 4.94x / 5.12x | -76.3% / -78.1% | 6.00x / 6.69x |
| BTC (2017-08) | -63.7% / -68.6% | 5.31x / 5.51x | -65.4% / -68.6% | 5.99x / 6.21x |
| LINK (2019-01) | -73.7% / (wick excluded*) | 8.63x / 10.56x | -75.5% / (excluded*) | 9.28x / 11.35x |
| UNI (2020-09) | -72.1% / -83.5% | 11.57x / 11.79x | -73.8% / -83.5% | 14.92x / 17.11x |

*LINK's raw wick-basis 90d "low" is -100.0%: the 2020-03-13 Binance
LINKUSDT flash-liquidation wick to ~$0.0001, a single-venue order-book
artifact the volume-weighted Chainlink index never printed - excluded
with that label, close basis retained. UNI's -83.5% wick (window from
2025-08-13) has no such attribution and is kept.

Rule, derived from those facts plus the recalibration cadence: **the
sanity rail is per-asset and ASYMMETRIC, centered on the composed price
READ AT EXECUTION, re-centered on an EXECUTION-to-execution cadence of
<= 90 days** (spec: executeRouteRecalibration; the payload carries the
width as 1e18-scaled ratios and execute centers them on the price it
reads then; the runbook derives SUBMISSION dates from the execution
schedule and the deadline watcher enforces executions, because a
submission cadence alone lets one refresh execute at eta and its
successor near its snapshot deadline or through a 30-day rail-only
window - stretching the governed span to ~111-120 days). The widths are
therefore sized on the **120-DAY columns**, so even a maximally late
execution cannot outrun them - and for LST/LRT routes the DOWN side is
COMPOUNDED, because the rail binds the EFFECTIVE composed price
(underlying x ratio), so a concurrent drawdown and market-ratio depeg
multiply: **LST/LRT routes: [P/6, 8P]** - the ETH 120d wick drawdown
(-78.1% -> 0.219) times the largest sourced ratio transient (-11.76%,
A.3) gives 0.219 x 0.8824 = **0.193P, which PIERCES P/5**; P/6 = 0.167
covers it with a 16% margin, and the UP side needs no compounding (even
a 2% ratio premium, above anything in the A.2 record, leaves 6.69 x
1.02 = 6.82 < 8); **direct ETH and BTC routes: [P/5, 8P]** (P/5 = -80%
below the worst 120d closes -76.3%/-65.4%, thin 1.9-point margin on the
ETH wick basis stated; 8P = 20% above the 6.69x 120d worst);
**LINK: [P/5, 12P]** (11.35x wick 120d worst); **UNI: [P/8, 20P]** (the recorded 17.11x 120-day move pierces a 16P
rail, so 16P was WRONG for a late execution - 20P covers it with 17%
margin, and P/8 = -87.5% sits below the -83.5% wick worst); **any
underlying not in the table: NO default** - same per-listing derivation
discipline as everything else here. The low side
stays tight everywhere it can (undervaluation is the direction that
collapses the floor; the depeg direction rule and divergence band bind
there), the high side follows each asset's recorded bull runs - and at
UNI-class widths the rail is explicitly ONLY a decimals-fault net
(1e10-class, aggregator mis-scale), which is its actual job; it was
never the shallow-fault defense (A.5 is).

Centering at EXECUTION is load-bearing: a center committed at submission
ages through the timelock before service even begins, so an allowed
60-day DELAY plus the 90-day cadence would leave one center governing
~150 days of drift - beyond the 90-day envelope the widths above are
derived from - while execute-centering keeps the governed span equal to
the execution-to-execution interval, <= 90 days at every allowed DELAY
(B.2 pipeline). The execute-time center is NOT taken on trust (an
erroneous certified print at execute must not launder a fault into the
accepted range): the payload also commits a reviewed ABSOLUTE range
`[execCenterLow, execCenterHigh]` the center must fall in, around the
SUBMISSION-time composed price S. Its horizon is `DELAY +
EXECUTE_WINDOW` (execution is permitted through `eta + WINDOW`), and the
range MUST be HORIZON-MATCHED, never blanket rail-width: on an
UNANCHORED route the range is the ONLY absolute gate at re-center
(anchored routes also face the divergence read), and a rail-width range
re-admits the very laundering it exists to stop - a fresh erroneous 7P
print passes [S/5, 8S] AND the old [P/5, 8P] rail, re-centers the rail
to [1.17P, 56P], freezes the route when the feed returns to truth, and
every repeat ratchets the accepted band outward. Measured worst moves
per horizon (wick basis, listing month excluded; LINK's down column uses
its close basis, -51.2/-57.7/-62.2%, with the labeled 2020-03-13
near-zero wick excluded - UNI's wick governs the class):

| Horizon (>= DELAY+WINDOW) | ETH/BTC down / up | range | LINK/UNI down / up | range |
|---|---|---|---|---|
| 2 days | -55.8% / 1.50x | **[S/3, 2S]** | -75.2% / 2.00x | **[S/5, 2.5S]** |
| 8 days | -64.9% / 1.87x | **[S/4, 3S]** | -76.1% / 2.71x | **[S/5, 3S]** |
| 31 days | -69.8% / 3.37x | **[S/4, 4S]** | -80.4% / 5.18x | **[S/8, 6S]** |
| 120 days | -78.1% / 6.69x | **[S/5, 8S]** | -83.5% / 17.11x | **UNI [S/8, 20S], LINK [S/5, 12S]** |

Pick the smallest row covering the config's `DELAY + WINDOW`; LST/LRT
low sides compound the -11.76% ratio transient exactly as the rail does
(rounded factors unchanged except the 120-day row's [S/6]). On the
recommended sovereign config (DELAY 24h, window <= 7d -> the 8-day row)
a 7S-class fault fails the 3S ceiling OUTRIGHT, killing the ratchet. At
long horizons the range necessarily widens toward the rail width, and
the residual is stated rather than hidden: an UNANCHORED route on a
long-DELAY vault retains a range-wide ratchet surface - such routes
should carry an anchor or run on short-DELAY deployments - while every
re-center still passes the full validation read, emits its events, and
stamps `railCenteredAt` for the watcher. A range miss from legitimate
drift only reverts the execute for a resubmit, and costs a second
timelock ONLY if the old rail is simultaneously breached. The guardian therefore sees the
worst-case absolute rail (range endpoint x rail ratio) during the veto
window, and the spec adds a center-inside-the-OLD-rail induction check
on top (waived only in rail recovery; spec: executeRouteRecalibration).
The depeg-exit consequence is now priced in directly rather than
assumed: an 11.76%-class transient ALONE never approaches any floor, and
the concurrent crash-plus-depeg product - the case that pierced P/5 - is
exactly what the LST/LRT P/6 floor is sized against, so the sell-side
exit survives every sourced stress event INCLUDING the compounded one. The residual this prices: a
certified-but-erroneous anchor may lower the floor anywhere inside the
divergence band (A.5) - the SANITY rail was never the defense against that;
the certified-pair requirement, the anchor<route direction rule, the
divergence band itself, and minBuyOverride are.

### A.4 Peer thresholds (primary)

- Aave/LlamaRisk stETH killswitch: **2.5%** market-vs-rate deviation is the
  emergency line (LTV to 0) - llamarisk.com/research/lst-pricing.
- SparkLend Kill Switch: freezes borrowing at a **5%** market depeg (0.95
  threshold for STETH/ETH) - makerdao/community governance poll 2024-03-25;
  SparkLend prices wstETH by exchange rate with the kill switch as the
  market-price backstop (vote.makerdao.com/polling/QmeWioX1).
- Gauntlet bounding condition: market-vs-rate divergence tolerance must be
  upper-bounded by 1 - LT (liquidation threshold) - forum link in A.1.

### A.5 Derived recommendation

| Route class | maxDivergenceBps | Derivation |
|---|---|---|
| Standard tier: CANCELLED comparison, feed deviation-threshold SUM in (50, 100] bps (e.g. the common 0.5% + 0.5% ExR-vs-market pairing = 100) | **130** | envelope = sum 100 + margins 25 = 125 additive; worst-case divergence composes MULTIPLICATIVELY because the band divides by routeValue: (1.00625 / 0.99375) - 1 = 125.8 bps -> 130 (rounded up to 5). Sits BELOW Aave's 250 emergency line and below the sourced deep-depeg magnitudes (290/600/800). |
| Tight tier: CANCELLED comparison, feed deviation-threshold SUM <= 50 bps (e.g. two Unichain 0.05% ExR legs = 10; 0.05% vs 0.2% = 25; tETH/wstETH 0.02% + 0.05% = 7) | **80** | envelope = 50 + 25 = 75 additive -> multiplicative (1.00375 / 0.99625) - 1 = 75.3 bps -> 80, margins fully preserved. |
| NON-cancelling comparisons, or sum > 100 bps (e.g. mainnet CBETH/ETH market at 1%): NO class default | derived per route | non-cancelling shapes start from the measured 2-minute desync statistics above (p99.9 55 / max 164 bps get ADDED to the envelope); sum > 100 uses the multiplicative worst of (sum + 25), rounded up to the next 25; both flagged in listing review. |

Tier membership is decided by ONE arithmetic test - sum the two sides'
deviation thresholds (after removing any shared leg that cancels) - never by
feed family. Consequences the review made explicit: canceling a shared
ETH/USD leg does NOT by itself qualify a route for the tight tier (two
remaining 0.5% legs still sum to 100 -> standard tier); Unichain's 0.05% ExR
against the chain's 0.5% ETH/USD (sum 55) lands standard tier; and the test
is INAPPLICABLE to a source without a published deviation threshold - which
includes the RedStone wstETH/ETH anchor on Unichain (its permissionless
update path has no Chainlink-style deviation trigger), so that
registration-anchored route gets NO numeric class default: its divergence
value is set per listing from measured update behavior of the actual anchor,
through the timelock like everything else.

**Detection floor, stated honestly:** with standard-tier feeds the band
cannot distinguish a shallow depeg from legitimate noise. With the sourced
margins the standard tier lands at 130 bps, which DOES react to the rsETH
April-2024 event (150 > 130) - an improvement over the earlier
unsourced-margin draft - but events at or under ~130 bps remain inside the
legitimate-noise envelope of 0.5%-deviation feeds and are structurally
undetectable there; the tight tier detects from ~80 bps. This is a physics limit of the feed specs, not a
tunable: shrinking the standard band below its own noise envelope trades a
undetectable-shallow-event risk for recurring false fail-closed downtime.
The residual exposure is bounded: a shallow in-band divergence mis-prices the
floor by at most the band width, and the curator's `minBuyOverride` binds
independently of it.

Both are per-token `TokenAdd` values behind the timelock; these are the class
defaults, and the C5 trial runs `anchorBandState` monitoring to record the
observed divergence distribution BEFORE real size migrates - any tightening is
then based on our own measured data.

### A.6 Turnover charge gross-up (`turnoverGrossUpBps`), sized

The spec's C4 charge is the order NOTIONAL with the price grossed up -
`grossedPrice18 = mulDiv(sellPrice18, 10_000 + uint256(turnoverGrossUpBps),
10_000)`, then `sellUsd18 = sellAmount x grossedPrice18 /
10**sellTokenDecimals`, Phase B's _validateAndPrice shape
(multiply-before-divide normative - the literal `x (1 + bps/1e4)`
truncates to an ungrossed charge in integer math, and a price-only
equality would charge size-independently, deleting the cap for large
orders) - with the gross-up PERSISTED per route (reviewed at
TokenAdd, refreshed by recalibration). What it must bound is the route's own
worst IN-BAND underreport of USD value - NOT divergence: the divergence band
is anchor-relative and definitionally blind to common-mode error (route and
anchor low by the same factor read as agreeing), so `maxDivergenceBps` is
the wrong quantity, and the anchor plays no role in the charge at all. The
same formula applies to anchored and unanchored routes.

**Formula:** an in-band-low route reads `true x prod(1 - term_i)`, so the
charge must DIVIDE the underreport back out rather than mirror it:
`turnoverGrossUpBps` = `1/prod(1 - term_i) - 1`, rounded UP to the next
5 bps. (Both the additive `1 + sum(term)` and the product `prod(1 + term)`
undershoot the compounded worst case - the gross-up is applied to a value
that is already the SHRUNKEN side of the envelope.) Per-leg terms:

- market-priced leg (ETH/USD, or any leg whose underlying moves at market
  speed): term = its deviation threshold + a **245 bps** update-landing
  allowance. Mechanism: a fresh feed either has not drifted past its
  threshold (error <= threshold) or has, and the triggered update lands
  within the ~2-minute propagation lag Gauntlet documented (A.1) - during
  which the market moves at most the 2-minute extreme. A trigger fires at
  ANY instant, so the statistic is the ANY-START bound
  `max(high[i..i+2]) / low[i] - 1` (every <=2-minute window opening
  anywhere in minute i starts >= low[i] and peaks <= the straddled highs
  - over-covering by construction; close-anchored 2-minute maxes, ETH
  164.3 bps, bracket from below). Measured PER UNDERLYING (30-day
  1-minute Binance samples read 2026-08-02, 43.2k candles each): max ETH
  **211.3** / BTC **155.8** / LINK **206.1** / UNI **241.1** bps; p99.99
  146.2 / 107.5 / 153.7 / 205.5. The allowance is set to **245 bps for
  all four measured underlyings** - the cross-asset envelope of the
  30-day samples - and it is a NORMAL-REGIME RESERVE, not a bound; the
  stress tail is modeled separately rather than a short-sample maximum
  being promoted to a bound. Measured across the nine recorded crash
  days of the full history (2018-02-05, 2020-03-12/13, 2021-05-19,
  2022-05-12, 2022-06-13, 2022-11-09, 2024-08-05, 2025-10-10),
  close-basis 2-minute envelopes reach ETH **1,333** / BTC **1,502** /
  LINK **2,846** / UNI **3,994** bps (single-venue wick-basis extremes
  run higher still - ETH 1,714, UNI 11,520, LINK's is the labeled
  near-zero artifact - but a volume-weighted index does not print lone
  order-book wicks, so close basis is the representative index bound).
  The residual is therefore stated, not hidden: a registration whose
  feed is mid-landing during a crash-class 2-minute window under-reserves
  by up to (stress envelope - 245); such windows occurred on ~9 days in
  ~3,200 recorded, each lasting minutes, the rolling-24h <= ~2x cap
  bound holds regardless, and `turnoverGrossUpBps` is a per-route
  REVIEWED field - an operator who wants the stress envelope priced into
  every order may size it so (at the stated cost: a 13-40% permanent
  charge premium). Any underlying not measured here gets NO default: its
  30-day any-start landing envelope is measured at listing review, and
  the allowance is max(own measured max rounded up, 245).
- PROTOCOL exchange-rate leg read from a FEED (the contract-rate mirrors:
  rETH-ETH ExR, weETH/eETH ExR, tETH/wstETH ExR classes): term = the
  feed's own deviation threshold + **25 bps**, the SAME sourced margin set
  as A.1 (15 = 3x measured calm-market basis + 10 labeled jitter). The
  feed's promise is only update-on-threshold-or-heartbeat, so it may sit
  up to its threshold from truth while fresh - a 0.5% ExR feed contributes
  50 bps of in-band error the margins alone do not cover. No landing
  allowance on top: the underlying CONTRACT RATE moves ~3%/yr (A.1) and
  cannot gap intra-minute, so movement inside the ~2-minute landing lag
  stays inside the 10-bps jitter allowance.
- MARKET-ratio leg read from a FEED (STETH/ETH market, CBETH/ETH market
  classes) is a MARKET-SPEED leg, not a slow rate leg: the ratio is a
  traded price that can gap during a fast crash or repeg - the record's
  11.76% momentary market-vs-rate divergence (A.3) is exactly such a
  window - so its in-band error is NOT bounded by threshold + 25. Term =
  its deviation threshold + a landing envelope MEASURED FOR THAT RATIO
  SERIES at listing review (any-start method as above); NO numeric
  default here, because no ratio series was measured in this document.
- registration-only rate leg read LIVE from the token contract (no feed, no
  update threshold): term = **25 bps**, the margins alone - a direct read
  has no feed lag; the term covers basis against real value, and a
  LIP-23-scale rebase day (~19 bps) still fits inside it.

**TTL appreciation is a separate term, and it is not oracle error:** the
composition envelope above bounds MISMEASUREMENT of value at the charging
instant; between registration and fill (up to the order TTL, decision 6:
1 hour) the sell asset can genuinely REPRICE, and a fill at the
appreciated price moves more USD than was reserved - the 1271 fill check
is a STATICCALL and cannot append the difference to the bucket. Sampling
methodology matters and is stated: a close-to-next-hour-high series only
models orders registered exactly AT hourly candle closes, while
`rebalance` registers at ANY instant. The statistic used is therefore the
ANY-START BOUND `max(high[i], high[i+1]) / low[i] - 1`: every <=1h window
opening at any offset inside candle i starts at a price >= low[i] and
peaks <= max of the two straddled highs, so the bound COVERS every
possible order window - over-covering by construction (it spans up to 2h
wick-to-wick; the close-anchored p99s, ETH 363 / BTC 295 / LINK 462 /
UNI 461 bps, bracket the true any-start value from below). Computed over
each symbol's full Binance 1h history:

| Sell asset | p99 (bps) | p99.9 | p99.99 | envelope (p99 rounded up) |
|---|---|---|---|---|
| ETH-exposure | 682 | 1,453 | 2,751 | **685** |
| BTC | 569 | 1,202 | 2,243 | **570** |
| LINK | 839 | 1,838 | 4,517 | **840** |
| UNI | 857 | 2,011 | 5,924 | **860** |
| USDC vs USD (synthetic: USDCUSDT x Coinbase USDT-USD, 2021-05+) | 32 | 214 | - | **35** |
| USDT vs USD (Coinbase USDT-USD direct, 2021-05+) | 21 | 104 | - | **25** |

Raw sample MAXIMA are dominated by documented single-venue wick
artifacts (ETH's +114% intra-candle 2017-08-22 listing week, LINK's
2020-03-13 near-zero wick, UNI's 2020-09-17 listing day) and are not the
sizing basis; the close-anchored maxima (ETH +24.4% on 2020-03-13) remain
the representative extreme prints. Recommended default: fold the SELL
asset's any-start p99 into the stored value - `turnoverGrossUpBps =
(1/prod(1 - term_i)) x (1 + ttlP99) - 1`. STABLE-SELL routes take a
PER-STABLE measured envelope, **never zero**: a stable order registered
below peg that recovers inside the TTL fills at genuinely higher USD
value, so a zero envelope under-reserves precisely in the scenario that
produces stable-sell repricing. And the measurement must be
USD-DENOMINATED, not a stable-vs-stable cross: a cross (USDCUSDT) and
its reciprocal stay near 1 while BOTH stables recover together from a
common discount, so neither direction of the cross bounds either asset's
USD appreciation. The series used: Coinbase's real USDT-USD book
(direct), and synthetic USDC/USD = USDCUSDT x USDT-USD. Recorded
extremes behind the p99.9 column: USDT +1,049 bps in the 2021-05-19
flight-to-stable and +728 bps on 2025-10-10; USDC's March-2023
depeg-recovery hours; the synthetic maxima column is withheld because
the extremes-product construction over-bounds absurdly when both
components are volatile (its top row, +400% on 2021-12-04, is a lone
mispriced Coinbase candle with no corroborating market event - labeled
data artifact). Every admitted stable is measured against a
USD-denominated series (direct or synthetic) before listing; no
universal stable default exists. A route whose composition includes a MARKET-RATIO leg has TWO
repricing factors inside the TTL - the USD underlying AND the ratio
itself (a depegged LST recovering during the order's hour) - so its TTL
envelope COMPOUNDS the underlying's row with a per-listing measured
any-start 1h envelope of the ratio series; no ratio series was measured
in this document, so such routes have NO default and the compounding is
a listing-review obligation. The tail beyond p99 is accepted and
stated: overshoot requires the pump to land inside the order's open
TTL, the p99.9 column bounds all but ~0.1% of windows, and the Phase-B
rolling-24h <= ~2x cap bound holds regardless; the order TTL is the
knob (shorter TTL, smaller envelope - re-measure at the chosen TTL).

Worked defaults (reciprocal form, ETH-exposure sell asset, ttlP99 = 685
bps, landing 245): standard route, 0.5% PROTOCOL ExR FEED rate leg +
0.5%/1h ETH/USD leg: (1/((1 - 0.0075)(1 - 0.0295))) x 1.0685 - 1 =
1,093.0 bps -> **1095**. Same shape on an Arbitrum-style 0.05%/24h
ETH/USD leg: 1,041.8 bps -> **1045**. Live-read rate leg + 0.5%/1h
ETH/USD: 1,037.4 bps -> **1040**. A stable-sell rotation applies
x 1.0060 to its own (small) composition envelope instead. Overcharge at
this scale is fail-closed: charges on volatile-sell orders land
~10.4-11% above live - the stated price of a reservation that covers 99%
of ANY-START windows on record - the effective daily budget shrinks by
the same factor, and operators size `dailyUsdTurnoverCap` knowing that.
If that price is judged too high for a given vault, the reviewable trade
is a shorter TTL, not a thinner envelope.

**The residual beyond the envelope, quantified rather than waved at:** the
one in-model way a FRESH leg can be wrong by more than
deviation-plus-landing is an update-landing outage longer than the
~2-minute norm coinciding with a fast market move, sustained inside
`maxStaleness`. Underreporting - the direction that stretches turnover -
needs an UP-move. Bounding facts, computed from the full Binance ETHUSDT
1h-kline history (78,415 candles) in BOTH bases - close-anchored worst
up-moves +24.4% (1h) / +42.8% (2h) / +47.9% (25h), and the ANY-START
low-to-straddled-high bound (an outage can begin at any instant, so the
close anchor alone under-states): **+60.5% (1h and 2h)** and **+62.4%
(25h)**, all from the 2020-03-13 rebound off the capitulation wick
(listing-month candles excluded; the wick anchor is partly single-venue,
so the truth sits between the two bases - both stated, the any-start
value used as the outer bound). (Single-venue candle wicks on
the first thin-book listing days run higher; Chainlink aggregates
volume-weighted across venues, so close-to-high over the liquid record is
the representative bound.) A route whose USD leg runs a 1h-class staleness
budget therefore has its actual-vs-charged ratio bounded by ~1.61/(1 + E)
on the any-start basis (~1.24 close-anchored) even through the worst
recorded pump-during-outage coincidence; a 25h-class budget admits ~1.62
(~1.48 close-anchored). The exposure is transient (it lasts at most
the stall), requires the coincidence, and the SAME stalled reads corrupt
the C2 oracle floor - the direct value path - so `maxStaleness` is a
turnover parameter as well as a floor parameter: listing review sizes it
with both in mind, and folding the full staleness envelope into every
charge instead would permanently burn 20-50% of the budget to prepay that
coincidence. Beyond THAT: an in-band error on a fresh leg exceeding
deviation-plus-landing means a certified aggregator no longer updating
past its own threshold - a write-path malfunction of the root of trust the
oracle floor itself stands on, out of the model for the cap as for
everything else.

Unichain note: the only wstETH anchor there (RedStone wstETH/ETH) is not
certifiable under the write-path rule, so that route is registration-anchored /
Presign-only per the spec - and it gets NO numeric class default: RedStone
publishes no Chainlink-style deviation threshold, so the arithmetic tier test
is inapplicable (A.5). Its registration-time divergence value is set per
listing from the anchor's MEASURED update envelope, through the timelock.

## B. CAPO growth ceilings (`maxGrowthPerYearBps` / `minGrowthPerYearBps`)

### B.1 Adopt Aave's deployed values (primary: bgd-labs/aave-capo deploy scripts)

These exact values are live in production securing Aave collateral across 10+
chains, derived by Chaos Labs' published framework (14-day MA of organic APY +
1.5-sigma volatility buffer; governance.aave.com/t/chaos-labs-correlated-asset-price-oracle-framework/16605)
and consistent across chains in `bgd-labs/aave-capo/scripts/Deploy*.s.sol`:

| Asset (rate leg) | maxYearlyRatioGrowthPercent (Aave, deployed) | Our maxGrowthPerYearBps |
|---|---|---|
| wstETH/stETH | 9.68% | **968** |
| weETH/eETH | 8.75% | **875** |
| rETH/ETH | 9.30% | **930** |
| ezETH/ETH | 10.89% | **1089** |
| rsETH/ETH | 9.83% | **983** |
| cbETH/ETH | 8.12% | **812** |
| sUSDe/USDe | 15.19% (Aave) | **DEFER - see B.3** |

Cross-check against observed base yields (DefiLlama daily APY series, pool ids
in the research log): medians cluster at 2.7-3.1% for the ETH LSTs with
all-time single-day prints up to 11.77% (stETH, 2025-02-03). A single-day
print above the cap is safe ONLY when headroom has accrued since the
snapshot - immediately after a FRESH snapshot there is none, and that 11.77%
day adds ~3.2 bps to the ratio while a 9.68%/yr linear bound allows ~2.65 bps
for that day: the read would revert. Aave's mechanism for exactly this is
MINIMUM_SNAPSHOT_DELAY (7 days ETH LSTs / 14 days others,
PriceCapAdapterBase.sol + the Chaos framework post): the snapshot ratio must
be an observation AT LEAST that old. **We adopt the rule as a bounded,
DELAY-AWARE window enforced on-chain by executeRouteRecalibration: the
observation's age at EXECUTE must lie in [14 days, 21 days + DELAY]** -
and the window binds EVERY path that installs a RateBound, not just
recalibration: `executeTokenAdd` enforces the same age window plus
live-ratio-vs-new-bound check, and the constructor's initial set enforces
[14 days, 21 days] with no timelock transit (spec: execute-time
validation) - otherwise an add or remove-and-re-add installs an
arbitrarily old observation and pre-grants `(cap - realized) x age` of
instant headroom, bypassing the 21-day slack cap this section derives. The
observation is committed at submission and ages through the timelock, so a
fixed [14, 21] would be unreachable for any vault whose DELAY exceeds 21
days (the review caught this): the ceiling therefore carries the vault's
own governance delay - the exact [14, 21] target is realized on the
recommended sovereign config (DELAY = 24h, prompt execution), and a
long-DELAY vault's extra pre-granted slack is a consequence of ITS
governance choice, bounded at (cap - realized) x (21d + DELAY) and
documented rather than hidden. Stated precisely, because "cushion" is CONDITIONAL, not automatic:
the slack at any moment is (cap - realized growth) x observation age - prior
growth CONSUMES the linear allowance rather than creating headroom. With
observed medians (~3%) against a 9.68% cap, 14 days give (9.68 - 3)% x
14/365 ~= 25.6 bps of slack vs ~3.2 bps for the worst observed single-day
print (~8x margin); a regime that sustains AT the cap has zero slack by
definition - but that is a mis-sized cap (or an sUSDe-class asset, B.3), a
different failure than a spike. The UPPER bound exists because a minimum
alone is arbitrarily loose: the window pre-grants (cap - realized) x age of
headroom a manipulated rate could consume before tripping - correctly
computed, that is 8.22 bps per percentage-point of cap-minus-realized gap
per 30 days (1% x 30/365), i.e. ~55 bps at 30 days for the 6.68-point
wstETH gap. Capping the age at 21 days bounds the pre-granted slack at
~38 bps while leaving a 7-day execution window for the timelocked
recalibration (comfortably above DELAY >= 24h). (Aave's own outer rail is
MAXIMUM_SNAPSHOT_TERM = 180 days; our 90-day recalibration cadence in B.2
sits at half of it, and the observation-age window binds independently.)

### B.2 Our snapshot-cadence delta, and the resulting runbook rule

Aave refreshes snapshots semi-automatically; our snapshots advance ONLY via the
P3 timelock. Rule derived from Aave's own bound, DELAY-AWARE because an
observation can already be `21 days + DELAY` old when it goes live (the B.1
execute-time window): **re-snapshot every rate leg at most `min(90 days,
159 days - DELAY)` apart**, so no ACTIVE snapshot ever exceeds the 180-day
maximum term the cadence is derived from (interval + 21d + DELAY <= 180d; a
bare 90-day interval plus a 90-day-DELAY install age would let a snapshot
serve to ~201 days old). On the recommended sovereign config (DELAY = 24h)
the plain 90-day cadence leaves a worst active age of ~112 days; at the
constructor's 90-day DELAY ceiling the interval tightens to 69 days.
The cadence is SCHEDULABLE at every allowed DELAY because recalibrations
PRE-STAGE (spec: recalibration execution does not advance the token nonce;
rollback is prevented by submission-time monotonicity plus strictly
increasing per-leg snapshotTs, not by serialization): a successor is
submitted while its predecessor is still pending. At the 90-day DELAY
ceiling: submit every 69 days, each payload executing 90 days after its
submission - every observation is 90 days old at install (inside the
111-day window) and no snapshot serves past 159 days of age, under the
180-day term. Without pre-staging the formula would be self-contradictory
above DELAY ~79 days (next submit only after the previous execute, +DELAY
to mature, while the required interval is already shorter than DELAY).
Encoded as a runbook item with a monitoring nag. At a 3% real yield a 90-day-stale snapshot
consumes ~0.75% of a ~9% annual budget - ample headroom - while a stalled
snapshot past 90 days is an operational alert well before any legitimate
accrual could approach the cap.

### B.3 sUSDe: defer listing rather than guess

Observed sUSDe base APY: all-time max **55.87%** (2024-03-07), p90 **23.34%**,
long negative-to-flat stretches (0.00% on 2024-05-02) - DefiLlama series
66985a81-9c51-46ca-9977-42b4fe7bc6df. Sustained multi-week yields above Aave's
15.19% cap are in the historical record - and the reason that cap works for
Aave and cannot work for us is a MECHANISM difference, not cadence: Aave's
CAPO adapter CLAMPS an above-bound price (the market keeps operating at a
conservatively capped valuation; PriceCapAdapterBase returns the capped
ratio), while our C18 posture REVERTS. No snapshot cadence rescues a revert
design here: with the 14-day observation window adopted in B.1, a 23.34%
regime sustained through the lookback grows the ratio ~0.81% while a 15.19%
linear bound allows ~0.58% - the snapshot is out of bounds AT ACTIVATION and
every read fails. The choices are a cap above the observed sustained regimes
(>2400 bps/yr, at which point the bound stops meaning anything) or hard
downtime whenever Ethena's funding regime spikes. sUSDe is not in launch
scope anyway (decision 7), so: **defer sUSDe; listing it later requires
either a clamp-class carve-out decision or acceptance of regime-driven
fail-closed windows - a product decision, not a calibration.**

### B.4 `minGrowthPerYearBps = 0` for the VERIFIED assets (the flat ratchet floor)

The flat floor is the default ONLY for the four scan-verified assets
(wstETH, rETH, weETH, cbETH) and contractually-floored sUSDe. ezETH and
rsETH are NOT covered by any default and cannot be listed with a flat
floor - or at all - until the per-listing review below supplies an
approved lower-bound policy for their AVS-slashing surface. Justified by
the factual record, per asset:

- **stETH/wstETH**: negative daily rebase has NEVER occurred on mainnet
  (docs.lido.fi tokens integration guide, checked 2026-08-02). The Oct-2023
  Launchnodes slashing (20 validators, ~25.7 ETH) was compensated BEFORE the
  rebase - not even a reduced day (research.lido.fi/t/5631,
  blog.lido.fi/post-mortem-launchnodes-slashing-incident). Lido's own sanity
  bounds (OracleReportSanityChecker `0x147f8d3c...`, read on-chain 2026-08-02):
  annual increase limit 10%/yr, max CL decrease 3.6%/36 days, LIP-23 second
  opinion oracle for larger drops.
- **rETH**: 1,676 daily on-chain samples of `getExchangeRate()` over 4.7 years
  (Nov 2021 - Aug 2026): ZERO decreases; losses are socialized behind node
  operator bonds + RPL collateral (docs.rocketpool.net protocol FAQ).
- **weETH**: 990 daily on-chain samples of `getRate()` (Nov 2023 - Aug 2026):
  ZERO decreases; no slashing incident to date (hackmd.io/@PrismaRisk/weETH).
- **cbETH**: 1,156 daily on-chain samples of `exchangeRate()`
  (`0xBe9895146f...`, selector 0x3ba0b9a9) over ~3.2 years (Aug 2022 - Aug
  2026, archive eth_call, method as for rETH/weETH): ZERO decreases; rate
  1.00480 -> 1.11414.
- **ezETH, rsETH: UNVERIFIED - flat floor NOT approved by this document.**
  No rate-history scan was run for either, and both are RESTAKING assets
  whose AVS-slashing surface the verified LSTs do not carry, so their rates
  CAN legitimately fall in ways the record above does not cover. Listing
  either requires the same archive-scan verification (daily monotonicity
  over the full token history) plus a slashing-model review, per listing,
  before `minGrowth 0` is adopted for it.
- **sUSDe** (when listed): the share price contractually cannot decrease -
  negative funding is absorbed by the separate reserve fund, never the staking
  contract (docs.ethena.fi technical-design/staking-usde).

A negative rebase remains POSSIBLE by design for the ETH LSTs (bounded to
~0.19%/day by LIP-23 for Lido). What the flat floor actually guarantees -
stated precisely, because the naive claim is wrong: the module never accepts
a ratio BELOW THE LAST VERIFIED SNAPSHOT. It does NOT fail on every negative
rebase - after yield has accrued headroom above the snapshot (and the 14-30
day observation window means some headroom exists from activation), a small
dip that stays above the snapshot passes silently. That is the intended
semantics: the floor exists to catch CUMULATIVE declines and fault-class
drops below a governance-verified level, not to alarm on every bounded
oracle wiggle. Whether a bounded dip trips is purely a race between dip size
and accrued headroom: near a fresh recalibration (14-day-old observation at
~3% median yield ~= 11.5 bps of headroom) a LIP-23-scale ~19 bps dip DOES
reach below the snapshot and fails the leg closed - the correct posture for
an unexplained decline right after a governance verification - while the
same dip months later passes silently inside accumulated headroom.
Monitoring (not the module) watches for any negative day-over-day rate
movement as an alertable signal in both cases.

## C. The ask (approve = these become the TokenAdd defaults)

- `maxDivergenceBps` by the ARITHMETIC TIER TEST of A.5, valid ONLY for
  denominator-CANCELLED comparisons (measured 2-minute desync makes
  non-cancelling shapes unclassifiable): sum <= 50 bps -> **80**; sum in
  (50, 100] -> **130** (margins now sourced: 15 basis = 3x measured, + 10
  labeled jitter allowance; multiplicative composition). Non-cancelling
  shapes, sum > 100, or any side without a published deviation threshold
  (e.g. the Unichain RedStone anchor) -> NO default, per-route derivation
  from the measured statistics in listing review. Per-token overridable; C5
  trial monitors with `anchorBandState` before size migrates. Detection
  floor: the 130 tier reacts to the rsETH-2024 class (150 bps); events
  <= ~130 bps are structurally undetectable on 0.5%-deviation feeds (A.5).
- CAPO: **wstETH 968 / weETH 875 / rETH 930 / ezETH 1089 / rsETH 983 /
  cbETH 812 bps/yr**; `minGrowth 0` VERIFIED for wstETH, rETH, weETH, cbETH
  (on-chain monotonicity scans) and sUSDe (contractual); **ezETH + rsETH
  UNVERIFIED - per-listing scan + slashing review required before flat
  floor** (B.4). Recalibration via the spec's timelocked
  executeRouteRecalibration (bounds-only, non-disruptive, DELAY-aware
  observation window [14d, 21d + DELAY], live-ratio-vs-new-bound check,
  recovery mode for breached bounds) <= every min(90 days, 159 days -
  DELAY) so no active snapshot outlives the 180-day outer term -
  schedulable at every DELAY because refreshes pre-stage (B.2);
  **sUSDe deferred** -
  clamp-vs-revert product decision, not a calibration (B.3).
- Turnover gross-up: `turnoverGrossUpBps` per A.6 = the route's in-band
  composition envelope (reciprocal form) x the SELL asset's TTL
  appreciation envelope (the ANY-START p99 bound of 1h up-moves - a
  close-anchored sample only covers hourly-close registrations; fills
  reprice during the TTL and the static fill check cannot re-charge):
  standard ETH-exposure route **1095 bps**, live-read **1040**,
  Arbitrum-style **1045**; stable-sell rotations take PER-STABLE, USD-DENOMINATED
  recovery envelopes (USDC 35 via synthetic USDC/USD, USDT 25 via
  Coinbase USDT-USD - a stable-vs-stable cross cannot see both stables
  recovering together), never zero; market-ratio sell routes compound a
  per-listing measured ratio recovery envelope.
  Same formula anchored or unanchored; NOT maxDivergenceBps
  (anchor-relative, blind to common-mode) and NOT sanityHigh (~5-8x
  notional). Landing allowance 245 bps = any-start cross-asset envelope of the
  four measured underlyings (ETH/BTC/LINK/UNI); market-RATIO anchor feeds
  are market-speed legs with per-listing measured envelopes; unmeasured
  underlyings are measured at listing. Permitted-lag residual bounded by the computed
  any-start worst up-move over the staleness window (1h +60.5% / 25h
  +62.4%; close-anchored +24.4%/+47.9%), so `maxStaleness` is reviewed
  as a turnover parameter too; landing reserve is normal-regime 245 with
  the crash-day stress tail (1,333-3,994 bps close-basis) documented and
  operator-overridable per route; beyond-p99 TTL repricing bounded by
  the recorded per-TTL maxima and the rolling-24h <= ~2x cap bound.
- Sanity rail (absolute-price fault rail, NOT a divergence tool and NOT a
  turnover basis): **PER-ASSET and ASYMMETRIC, centered on the composed
  price AT EXECUTION, re-centered at every recalibration** - LST/LRT
  [P/6, 8P] (underlying drawdown x ratio depeg COMPOUNDED - the product
  pierces P/5 on the record), direct ETH & BTC [P/5, 8P], LINK
  [P/5, 12P], UNI [P/8, 20P], unmeasured assets NO default (sized on the 120-DAY columns so a late execution cannot outrun
  them - the cadence is normative on EXECUTIONS <= 90d apart; the old
  ETH-only [P/5, 5P] failed the record: every asset's bull-run up-moves
  pierce 5P, and UNI's recorded 17.11x 120-day move pierced even 16P).
  Payload carries the width as ratios plus a reviewed absolute center
  range HORIZON-MATCHED to DELAY + EXECUTE_WINDOW (A.3 table; 8-day row
  [S/4, 3S] on the recommended config - blanket rail-width ranges
  re-admit the unanchored-route ratchet A.3 documents) - a submission-time center would govern
  DELAY + interval of drift, and an unreviewed center would launder
  faults (A.3).
