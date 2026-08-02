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
Where route and anchor share the same ETH/USD leg, composing the anchor so the
denominator CANCELS (compare in ETH terms - the spec's composed-anchor rule
already supports this) removes that leg's threshold from the sum; route shapes
SHOULD do this wherever possible.

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
| Standard tier: feed deviation-threshold SUM in (50, 100] bps (e.g. the common 0.5% + 0.5% ExR-vs-market pairing = 100) | **155** | worst-case divergence composes MULTIPLICATIVELY, not additively, because the band divides by routeValue: route low by (dev 0.5% + desync 0.3%), anchor high by (dev 0.5% + basis 0.2%) gives (1.007 - 0.992) / 0.992 = 151.2 bps - already over an additive 150. 155 = the multiplicative worst case rounded up to the next 5. Sits BELOW Aave's 250 emergency line and below the sourced deep-depeg magnitudes (290/600/800). |
| Tight tier: feed deviation-threshold SUM <= 50 bps (e.g. two Unichain 0.05% ExR legs = 10; 0.05% vs 0.2% = 25; tETH/wstETH 0.02% + 0.05% = 7) | **105** | same multiplicative composition with sum <= 50: worst split (1.002 - 0.992) / 0.992 = 100.8 bps -> 105, margins fully preserved. |
| Sum > 100 bps (e.g. mainnet CBETH/ETH market at 1% paired with an ExR leg): NO class default | derived per route | value = multiplicative worst case of (sum + 20 + 30), rounded up to the next 25; flagged in listing review. A class default here would let feed noise alone consume the whole band. |

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
cannot distinguish a shallow depeg from legitimate noise - the rsETH
April-2024 event (-1.5% = 150 bps) sits INSIDE the standard tier's 155-bps
band (the normative comparison passes at `<= maxDivergenceBps`), so that
event class is NOT reliably detected on 0.5%-deviation feeds. It IS detected
on the tight tier (150 > 105). This is a physics limit of the feed specs, not a
tunable: shrinking the standard band below its own noise envelope trades a
undetectable-shallow-event risk for recurring false fail-closed downtime.
The residual exposure is bounded: a shallow in-band divergence mis-prices the
floor by at most the band width, and the curator's `minBuyOverride` binds
independently of it.

Both are per-token `TokenAdd` values behind the timelock; these are the class
defaults, and the C5 trial runs `anchorBandState` monitoring to record the
observed divergence distribution BEFORE real size migrates - any tightening is
then based on our own measured data.

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
be an observation AT LEAST that old. **We adopt the rule as a bounded WINDOW:
every recalibration uses a ratio observation between 14 and 21 days old**
(enforced on-chain by executeRouteRecalibration - see the spec's P3
surface). Stated precisely, because "cushion" is CONDITIONAL, not automatic:
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
P3 timelock. Rule derived from Aave's own bound: **re-snapshot every rate leg
at most 90 days apart** (half of Aave's 180-day maximum term), encoded as a
runbook item with a monitoring nag. At a 3% real yield a 90-day-stale snapshot
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

- `maxDivergenceBps` by the ARITHMETIC TIER TEST of A.5 (sum the two sides'
  deviation thresholds after cancelling shared legs; worst cases compose
  MULTIPLICATIVELY): sum <= 50 bps -> **105**; sum in (50, 100] -> **155**;
  sum > 100 or any side without a published deviation threshold (e.g. the
  Unichain RedStone anchor) -> NO default, per-route derivation in listing
  review. Denominator cancellation is an input to the sum, never a tier
  shortcut. Per-token overridable; C5 trial monitors with `anchorBandState`
  before size migrates. Known detection floor: shallow (<=155 bps) events
  are not reliably detectable on standard-tier feeds (A.5).
- CAPO: **wstETH 968 / weETH 875 / rETH 930 / ezETH 1089 / rsETH 983 /
  cbETH 812 bps/yr**, `minGrowth 0` everywhere (guarantee = never below the
  last verified snapshot; a bounded dip trips ONLY while headroom is thin -
  correct near a fresh verification, silent later; B.4); recalibration via
  the spec's new timelocked executeRouteRecalibration (bounds-only,
  non-disruptive) <= every 90 days, with the ratio observation aged 14-21
  days (conditional spike slack below, pre-granted-headroom slack capped
  ~38 bps above; B.1); **sUSDe deferred** - listing it is a clamp-vs-revert
  product decision, not a calibration (B.3).
- Sanity rail (absolute-price fault rail, NOT a divergence tool): **[P/5,
  5P] re-centered at every recalibration** - P/5 = -80% sits below the
  computed worst-ever 90-day ETH drawdown (-75.0%, Binance daily klines
  2017-2026), so no historically observed market path freezes a route
  between on-schedule recalibrations, while any order-of-magnitude fault
  still lands far outside (A.3).
