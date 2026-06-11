# Ophis Affiliate Program: Model & Strategy (v3)

Status: DRAFT for review. Rates + rebate split locked 2026-06-09. Owner: Clement.
Two kinds of affiliate: **Regular** (public, capped) and **Super VIP** (invite-only, uncapped; roster in `vip-roster.private.md`, gitignored).

---

## The whole thing in 30 seconds

> Share a referral code. Every time someone you referred trades, **you earn a share of the fee Ophis keeps on that trade, for life.** Paid in WETH, monthly, from the same Safe that pays rebates.
>
> - **Regular: 8% of the fee** (2x what CoW pays), **capped at $1M of referred volume per month.**
> - **Super VIP: 12% of the fee** (3x CoW), **uncapped** (the reward for being trusted: unlimited upside).
> - Only **net-new wallets** count. Binding locks on the referee's first paying trade, written into their signed order. You earn a slice of **realized fees, never a bounty on volume**, so abuse always loses money.

---

## Affiliate rates (unchanged by the rebate resize)

| | Rate | = bps of volume | vs CoW (0.4 bps) | Cap |
|---|---|---|---|---|
| Regular | 8% of fee | 0.8 bps | **2.0x** | **$1M referred volume / month** |
| Super VIP | 12% of fee | 1.2 bps | **3.0x** | **none** |

**Pay the % on the fee Ophis KEEPS, not the headline fee.** On Optimism we keep the full 10 bps. On the 11 CoW-hosted chains CoW takes 25% first, so we keep 7.5 bps and pay the % of *that*.

### What the affiliate pockets per month (independent of the rebate split)
| Volume driven | Regular (OP) | Regular (hosted) | VIP (OP) | VIP (hosted) |
|---|---|---|---|---|
| $500K | $40 | $30 | $60 | $45 |
| $1M | $80 | $60 | $120 | $90 |
| $5M | $80 (capped) | $60 (capped) | $600 | $450 |
| $10M | $80 (capped) | $60 (capped) | $1,200 | $900 |

---

## Protocol economics: Ophis keeps ~55% (rebate pool resized to 21.25% of net)

Decided 2026-06-09: the rebate pool drops from **50% of net to 21.25% of net** (`POOL_SPLIT_BPS 5000 → 2125`) so Ophis nets **55% of gross blended** (80% hosted / 20% OP). Per chain: **51.56% on hosted, 68.75% on Optimism.**

### Where every $1 of gross fee goes
| | CoW | Rebate pool | Affiliate | **Ophis** |
|---|---|---|---|---|
| Old (50% pool) — hosted | $0.25 | $0.375 | $0.075 | $0.30 (30%) |
| Old (50% pool) — OP | $0 | $0.500 | $0.100 | $0.40 (40%) |
| **New (21.25%) — hosted** | $0.25 | $0.159 | $0.075 | **$0.516 (51.6%)** |
| **New (21.25%) — OP** | $0 | $0.213 | $0.100 | **$0.688 (68.75%)** |
| **New — blended 80/20** | — | — | — | **$0.55 (55%)** |

### Ophis keeps, by total volume (new split)
| Volume | Ophis keeps (hosted) | Ophis keeps (OP) |
|---|---|---|
| $1M | $516 (51.6%) | $688 (68.75%) |
| $10M | $5,156 (51.6%) | $6,875 (68.75%) |

### Fleet (10 VIP + 50 Regular, $90M/mo, 80/20): before → after
| Line | Old (50% pool) | **New (21.25% pool)** | Δ |
|---|---|---|---|
| CoW takes | $18,000 | $18,000 | — |
| Rebate pool (traders) | $36,000 | **$15,300** | −$20,700 |
| Affiliate payout | $7,360 | $7,360 | — |
| **Ophis keeps** | $28,640 (31.8%) | **$49,340 (54.8%)** | **+$20,700** |

(Fleet lands at 54.8% rather than a clean 55% because the real affiliate mix nets 10.2% of net vs the 10.0% used to solve the split — immaterial.)

---

## The trade-off (consciously accepted)

The rebate pool falls from 50% to 21.25% of net = **42.5% of its former size**. At the fleet level it drops $36,000 → $15,300/mo (−57.5%); every dollar moves to Ophis. Traders still get a real rebate (~16% of gross on hosted, ~21% on OP), but the headline is no longer "we give half the fees back."

---

## Why it still cannot lose money

Per $1 of net fee: `keep = 1 − pool(0.2125) − affiliate`. Regular keeps **0.7075 of net**, VIP keeps **0.6675 of net**, before fixed ops. Positive on every chain and pair. Above the Regular cap, Ophis keeps even more (no affiliate paid). VIP uncapped is safe because every dollar paid is a fraction of a fee already collected.

---

## What stays simple

One flat rate per tier. No tier ladder, no holdback/clawback subsystem, no sybil-cluster heuristics, no guarantees, no two-sided referee discount in v1. Anti-fraud = net-new wallets + pay-on-realized-fees + the monthly batch window. VIP differentiates on perks (weekly payout, custom code, co-marketing, direct line) plus the uncapped rate. Reuses the rebate-indexer rails; no new contracts.

---

## Open follow-ons (NOT done yet — separate, deliberate steps)

1. **Flip the live constant:** `apps/rebate-indexer/src/tiers.ts` `POOL_SPLIT_BPS = 5000 → 2125`. This is a production economic change (auto-deploys to the Aleph rebate VM on push) — do it deliberately when ready, not casually. The pool currently holds ~0 WETH, so immediate impact is nil, but it sets policy.
2. **Site-wide rebate messaging:** any "50% of fees back to traders" copy on docs.ophis.fi / business / swap / rebates must change to the new ~21%-of-net framing before this is public. Needs its own sweep.
3. **Affiliate program build:** capture `?ref=` → appData → rebate-indexer attribution → Safe batch (no new contracts). Per earlier plan.

---

## Decisions still open

1. Regular cap: $1M/month referred volume (default). Raise/lower? Per-referrer (modeled) vs per-referred-wallet?
2. Referee perk in v1, or defer? (recommended: defer.)
