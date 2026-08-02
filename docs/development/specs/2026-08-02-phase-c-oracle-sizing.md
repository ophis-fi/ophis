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
Phase-C spec). Sizing implication, so the exit path actually survives a
fast crash of the cited magnitude: the SANITY band is the coarse absolute
plausibility rail and must be sized WIDE relative to the divergence band -
listing guidance is sanityLow at least 25-30% below the listing-time
composed price (comfortably under the 11.76% transient and every historical
depeg in A.3, while still catching decimal/aggregator-class faults, which
mis-scale by orders of magnitude, not tens of percent). A sanity band sized
tighter than the worst fast-crash transient silently converts the depeg-exit
path into a hard freeze - that is a per-listing review checkpoint, not a
default anyone should inherit blindly.

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
| Standard tier: any comparison whose feed deviation-threshold SUM is > 50 bps (e.g. the common 0.5% + 0.5% ExR-vs-market pairing = 100 bps) | **150** | threshold sum up to 100 + basis envelope 20 + update-desync margin 30. Sits BELOW Aave's 250 emergency line (we fail closed before peers declare emergencies) and FAR below every real depeg it must catch (290/600/800). |
| Tight tier: comparisons whose feed deviation-threshold SUM is <= 50 bps (e.g. two Unichain 0.05% ExR legs = 10; 0.05% vs 0.2% = 25; tETH/wstETH 0.02% + 0.05% = 7) | **100** | threshold sum <= 50 + the same 20 basis + 30 desync margins = <= 100, margins fully preserved. |

Tier membership is decided by ONE arithmetic test - sum the two sides'
deviation thresholds (after removing any shared leg that cancels) and compare
to 50 bps - never by feed family. Two consequences Codex-review made explicit:
canceling a shared ETH/USD leg does NOT by itself qualify a route for the
tight tier (two remaining 0.5% legs still sum to 100 bps -> standard tier),
and a pairing like Unichain's 0.05% ExR against the chain's 0.5% ETH/USD
(sum 55) sits just OVER the boundary -> standard tier, keeping the documented
margins intact rather than shaving them.

Both are per-token `TokenAdd` values behind the timelock; these are the class
defaults, and the C5 trial runs `anchorBandState` monitoring to record the
observed divergence distribution BEFORE real size migrates - any tightening is
then based on our own measured data.

Unichain note: the only wstETH anchor there (RedStone wstETH/ETH) is not
certifiable under the write-path rule, so that route is registration-anchored /
Presign-only per the spec; the 100 bps tier applies at registration time.

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
be an observation AT LEAST that old, so the bound activates with accrued
cushion already in place. **We adopt the same rule, conservative side: every
P3 re-snapshot uses a ratio observation >= 14 days old.** At a 3% median
yield that is ~11.5 bps of cushion at activation vs ~3.2 bps for the worst
observed single-day spike - a ~3.6x margin, and the margin GROWS every
below-cap day thereafter. (MAXIMUM_SNAPSHOT_TERM 180 days is the other Aave
bound; our 90-day runbook in B.2 sits at half of it.)

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
15.19% cap are in the historical record, which Aave absorbs with frequent
snapshot updates our timelock cadence does not match. A cap that trips on real
yield between quarterly re-snapshots means recurring fail-closed downtime; a
cap sized for the spikes (>2500 bps) is no longer a meaningful bound. sUSDe is
not in the launch scope (decision 7: Chainlink fill path + ERC-4626
registration legs), so: **defer sUSDe until a dedicated calibration with a
committed snapshot cadence.**

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
~0.19%/day by LIP-23 for Lido). Under the flat floor that event fails the leg
closed until a governance re-snapshot - the correct posture, and exactly the
operating consequence the spec already documents for a stalled rate.

## C. The ask (approve = these become the TokenAdd defaults)

- `maxDivergenceBps`: **150** (standard ExR-vs-market anchor routes) / **100**
  (tight-feed or denominator-cancelling comparisons); per-token overridable;
  C5 trial monitors before size.
- CAPO: **wstETH 968 / weETH 875 / rETH 930 / ezETH 1089 / rsETH 983 /
  cbETH 812 bps/yr**, `minGrowth 0` everywhere; re-snapshot runbook <= 90 days
  AND every snapshot uses a ratio observation >= 14 days old (the
  post-snapshot spike cushion, B.1); **sUSDe deferred**.
- Sanity bands (per-listing checkpoint, not a class default): `sanityLow` at
  least 25-30% below the listing-time composed price, so the depeg-exit path
  survives fast-crash transients (A.3) while still catching
  order-of-magnitude faults.
