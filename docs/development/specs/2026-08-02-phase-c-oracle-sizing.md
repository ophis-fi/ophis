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
exits) with both feeds agreeing. The bounding fact, computed from primary
data (Binance ETHUSDT daily klines, 2017-08-17..2026-08-02, 3,273 candles;
close-to-intraday-low, method in the research log): the worst 90-day ETH
drawdown on record is **-75.0%** (window starting 2022-04-03; worst 30-day:
-69.8%, 2020-02-14). Rule, derived from that fact plus the recalibration
cadence: **the sanity rail is [P/5, 5P] around the composed price at each
recalibration, re-centered at every <= 90-day recalibration** (spec:
executeRouteRecalibration). P/5 = -80% sits below the worst-ever 90-day
move with margin, so no historically observed market path can freeze a
route between on-schedule recalibrations - while ANY order-of-magnitude
fault (wrong decimals = 1e10-class, aggregator mis-scale) still lands far
outside it, which is the rail's actual job. The depeg-exit consequence
follows for free: an 11.76%-class transient never approaches P/5, so the
exit path survives every sourced stress event. The residual this prices: a
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

The spec's C4 charge is `sellUsd18 = live route price x (1 +
turnoverGrossUpBps/1e4)`, with the gross-up PERSISTED per route (reviewed at
TokenAdd, refreshed by recalibration). What it must bound is the route's own
worst IN-BAND underreport of USD value - NOT divergence: the divergence band
is anchor-relative and definitionally blind to common-mode error (route and
anchor low by the same factor read as agreeing), so `maxDivergenceBps` is
the wrong quantity, and the anchor plays no role in the charge at all. The
same formula applies to anchored and unanchored routes.

**Formula:** `turnoverGrossUpBps` = the multiplicative composition of
per-leg in-band error terms, rounded UP to the next 5 bps:

- market-priced leg (ETH/USD, or any leg whose underlying moves at market
  speed): term = its deviation threshold + a **165 bps** update-landing
  allowance. Mechanism: a fresh feed either has not drifted past its
  threshold (error <= threshold) or has, and the triggered update lands
  within the ~2-minute propagation lag Gauntlet documented (A.1) - during
  which the market moves at most the observed 2-minute extreme. 165 bps =
  the measured 30-day max 2-minute ETH move (164.3 bps, A.1) rounded up;
  p99.99 is 107.6 bps, so the allowance clears virtually every observed
  window with margin.
- rate leg read from a FEED (ExR or market LST ratio): term = the feed's
  own deviation threshold + **25 bps**, the SAME sourced margin set as A.1
  (15 = 3x measured calm-market basis + 10 labeled jitter). The feed's
  promise is only update-on-threshold-or-heartbeat, so it may sit up to its
  threshold from truth while fresh - a 0.5% ExR feed contributes 50 bps of
  in-band error the margins alone do not cover. No 165-bps landing
  allowance on top: the underlying RATIO moves ~3%/yr (A.1) and the sourced
  depeg events unfold over hours-to-months (A.3), so ratio movement inside
  the ~2-minute landing lag stays inside the 10-bps jitter allowance.
- registration-only rate leg read LIVE from the token contract (no feed, no
  update threshold): term = **25 bps**, the margins alone - a direct read
  has no feed lag; the term covers basis against real value, and a
  LIP-23-scale rebase day (~19 bps) still fits inside it.

Worked defaults (multiplicative, per the same composition rule as A.5):
standard route, 0.5% ExR FEED rate leg + 0.5%/1h ETH/USD leg:
(1 + 0.0050 + 0.0025)(1 + 0.0050 + 0.0165) - 1 = 291.6 bps -> **295**.
Same shape on an Arbitrum-style 0.05%/24h ETH/USD leg:
(1 + 0.0075)(1 + 0.0005 + 0.0165) - 1 = 246.3 bps -> **250**. Live-read
rate leg + 0.5%/1h ETH/USD: (1 + 0.0025)(1 + 0.0050 + 0.0165) - 1 =
240.5 bps -> **245**. Overcharge at this scale is fail-closed: charges
land ~2.5-3% above live, the effective daily budget shrinks by the same
factor, and operators size `dailyUsdTurnoverCap` knowing that.

**The residual beyond the envelope, quantified rather than waved at:** the
one in-model way a FRESH leg can be wrong by more than
deviation-plus-landing is an update-landing outage longer than the
~2-minute norm coinciding with a fast market move, sustained inside
`maxStaleness`. Underreporting - the direction that stretches turnover -
needs an UP-move. Bounding facts, computed from the full Binance ETHUSDT
1h-kline history (2017-08-17..2026-08-02, 78,415 candles;
close-to-window-high, method in the research log): worst up-move within 1h
**+24.4%**, within 2h **+42.8%** (both 2020-03-13, the COVID-crash
rebound), within 25h **+47.9%** (2021-01-03). (Single-venue candle wicks on
the first thin-book listing days run higher; Chainlink aggregates
volume-weighted across venues, so close-to-high over the liquid record is
the representative bound.) A route whose USD leg runs a 1h-class staleness
budget therefore has its actual-vs-charged ratio bounded by ~1.24/(1 + E)
even through the worst recorded pump-during-outage coincidence; a
25h-class budget admits ~1.48. The exposure is transient (it lasts at most
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

### B.4 `minGrowthPerYearBps = 0` for every listed asset (the flat ratchet floor)

Justified by the factual record, per asset:

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
  DELAY) so no active snapshot outlives the 180-day outer term (B.2);
  **sUSDe deferred** -
  clamp-vs-revert product decision, not a calibration (B.3).
- Turnover gross-up: `turnoverGrossUpBps` per A.6 - the route's own
  in-band composition envelope, same formula anchored or unanchored
  (standard route with a 0.5% ExR feed leg **295 bps**, live-read rate leg
  **245**, Arbitrum-style ETH/USD **250**), NOT
  maxDivergenceBps (anchor-relative, blind to common-mode) and NOT
  sanityHigh (~5x notional). Permitted-lag residual bounded by the
  computed worst up-move over the staleness window (1h +24.4% / 25h
  +47.9%), so `maxStaleness` is reviewed as a turnover parameter too.
- Sanity rail (absolute-price fault rail, NOT a divergence tool and NOT a
  turnover basis): **[P/5, 5P]
  re-centered at every recalibration** - P/5 = -80% sits below the computed
  worst-ever 90-day ETH drawdown (-75.0%, Binance daily klines 2017-2026),
  so no historically observed market path freezes a route between
  on-schedule recalibrations, while any order-of-magnitude fault still
  lands far outside (A.3).
