import { sql } from '../db/index.js';
import type { AffiliateReferrer } from './computeAffiliate.js';
import { GROSS_FEE_BPS, type AffiliateKind } from './rates.js';

// Reads the referral graph + trades and builds the per-referrer, per-chain referred
// volume for a cycle, ready for computeAffiliate().
//
// Tier resolution (v1): a referrer's effective tier for a cycle is PARTNER iff they
// currently hold an ACTIVE partner-kind ref_code, otherwise REGULAR. Regular is the
// lifetime floor: a referrer with bound referrals always earns at least the regular
// rate even if their code was later deactivated (revoking a partner code drops them
// to regular next cycle — revocation has teeth). One effective tier per referrer =>
// exactly one payout row per referrer (matches affiliate_batch_entries PK).
//
// Accrual counts a referred wallet's trades only AFTER its bound_at (so a referrer
// never earns on pre-binding history) and only within the cycle window. Volume is
// bucketed by (chain, effective gross bps) so computeAffiliate takes the tier share
// of the ACTUAL kept fee — the 5 bps SDK channel accrues half of the 10 bps retail
// channel — and applies the regular cap LEAST-VALUABLE-FIRST even within a chain
// that carries mixed-rate trades. Today every indexed trade is on a hosted chain
// (Optimism is not indexed); the bucketing is OP-ready for when OP indexing ships.

/** Referrers who currently hold an active partner code => partner tier this cycle. */
async function getPartnerReferrers(): Promise<Set<string>> {
  const rows = await sql<{ referrer_hex: string }[]>`
    SELECT DISTINCT encode(referrer_wallet, 'hex') AS referrer_hex
    FROM ref_codes
    WHERE active = true AND kind = 'partner'
  `;
  return new Set(rows.map((r) => `0x${r.referrer_hex}`));
}

/**
 * Build the AffiliateReferrer[] for the cycle [monthStart, monthEnd).
 * Counts trades from bound referred wallets that settled in-window and at/after the
 * binding, with a priced (non-null) value_usd. Returns one entry per referrer.
 */
export async function buildAffiliateReferrers(
  monthStart: Date,
  monthEnd: Date,
): Promise<AffiliateReferrer[]> {
  const partners = await getPartnerReferrers();
  // referrer -> payout redirect (migration 0007). A referrer may hold several codes;
  // DISTINCT ON collapses them to ONE payout wallet, preferring an ACTIVE code and a
  // partner code (a partner sets the redirect on their partner code), deterministically
  // tie-broken by code. Only codes WITH a payout_wallet are considered; a referrer with
  // none stays absent here => null => pay to referrer_wallet (identity). (Can't use
  // MAX(bytea) — no such aggregate in Postgres; DISTINCT ON is the bytea-safe form.)
  const payoutRows = await sql<{ referrer_hex: string; payout_hex: string }[]>`
    SELECT DISTINCT ON (referrer_wallet)
      encode(referrer_wallet, 'hex') AS referrer_hex,
      encode(payout_wallet, 'hex')   AS payout_hex
    FROM ref_codes
    WHERE payout_wallet IS NOT NULL
    ORDER BY referrer_wallet, active DESC, (kind = 'partner') DESC, code
  `;
  const payoutByReferrer = new Map<`0x${string}`, `0x${string}`>();
  for (const row of payoutRows) {
    payoutByReferrer.set(`0x${row.referrer_hex}` as `0x${string}`, `0x${row.payout_hex}` as `0x${string}`);
  }

  // Grouped by (referrer, chain, EFFECTIVE gross bps) — splitting volume by its
  // per-trade fee rate (NULL bps -> the legacy retail rate, so pre-split trades are
  // unchanged) lets computeAffiliate apply the regular cap LEAST-VALUABLE-FIRST even
  // when one chain carries mixed-rate (5/10/1 bps) trades.
  const rows = await sql<
    { referrer_hex: string; chain_id: number; gross_bps: number; volume_usd: string }[]
  >`
    SELECT
      encode(r.referrer_wallet, 'hex')                AS referrer_hex,
      t.chain_id                                      AS chain_id,
      COALESCE(t.volume_fee_bps, ${GROSS_FEE_BPS})::int AS gross_bps,
      SUM(t.value_usd)::text                          AS volume_usd
    FROM referrals r
    JOIN trades t ON t.wallet = r.referred_wallet
    WHERE t.block_timestamp >= ${monthStart.toISOString()}
      AND t.block_timestamp <  ${monthEnd.toISOString()}
      AND t.block_timestamp >= r.bound_at
      AND t.value_usd IS NOT NULL
      -- appData-wins: exclude from the bind path the trades the appData query below
      -- can CLAIM — those carrying an ACTIVE code owned by someone OTHER than the
      -- trader. A NULL/stale/inactive code OR a self-owned code is NOT excluded here
      -- and correctly falls back to this wallet-bind path. NOTE: this exclusion is
      -- bps-INDEPENDENT, while the appData arm now additionally requires
      -- volume_fee_bps > 0. So an active-non-self-code trade with a NULL/0 fee is
      -- excluded from BOTH arms (credited nowhere) until the self-healing backfill
      -- confirms its fee — deliberate (forge-safe), NOT a bind fallback. No
      -- double-count either way.
      AND NOT (
        t.appdata_ref_code IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM ref_codes rc
          WHERE rc.code = t.appdata_ref_code AND rc.active AND rc.referrer_wallet <> t.wallet
        )
      )
    -- Group by the gross_bps OUTPUT ALIAS, not a second COALESCE(...) literal: the
    -- sql tag binds each interpolation as a distinct parameter, so repeating the
    -- COALESCE here would be a different expression than the SELECT (Postgres 42803).
    GROUP BY r.referrer_wallet, t.chain_id, gross_bps
  `;

  // appData attribution: trades whose appData carries an ACTIVE referral code are
  // credited to that code's owner directly (no wallet bind required) — this is how
  // an agent builder's routed volume self-attributes. Self-referral (trader == code
  // owner) earns nothing (rc.referrer_wallet <> t.wallet). Disjoint from the bind
  // query above (which excludes exactly these trades), so no trade is double-counted.
  // Folded into the SAME byReferrer map below, so the Regular $1M cap (applied per
  // referrer in computeAffiliate) sees the COMBINED bind + appData volume.
  //
  // FEE GATE (appData arm only): require volume_fee_bps > 0 — a CONFIRMED Ophis Volume
  // fee. appdata_ref_code is attacker-controllable, so this is the forge surface; the
  // bind arm above is signature-gated and keeps its NULL->retail COALESCE for legacy
  // pre-per-trade-tracking rows. Excluding NULL here (vs the bind arm) closes the
  // surplus/PI-NULL -> retail-COALESCE forge at the money path, as a second line behind
  // the fetcher's attribution gate. Ophis emitters never emit surplus/PI, so a NULL on
  // an appData-attributed trade is forge-or-unconfirmed; a legit legacy NULL row is
  // converged to a positive rate by the self-healing backfill and then credited. The
  // dashboard's appData arm (api.ts) mirrors this exact > 0 gate so display == payout.
  const appdataRows = await sql<
    { referrer_hex: string; chain_id: number; gross_bps: number; volume_usd: string }[]
  >`
    SELECT
      encode(rc.referrer_wallet, 'hex')               AS referrer_hex,
      t.chain_id                                      AS chain_id,
      t.volume_fee_bps::int                           AS gross_bps,
      SUM(t.value_usd)::text                          AS volume_usd
    FROM trades t
    JOIN ref_codes rc ON rc.code = t.appdata_ref_code AND rc.active
    WHERE t.appdata_ref_code IS NOT NULL
      AND t.block_timestamp >= ${monthStart.toISOString()}
      AND t.block_timestamp <  ${monthEnd.toISOString()}
      AND t.value_usd IS NOT NULL
      AND rc.referrer_wallet <> t.wallet
      AND t.volume_fee_bps > 0
    GROUP BY rc.referrer_wallet, t.chain_id, gross_bps
  `;

  // referrer -> "chainId:grossBps" -> bucket. Both result sets are summed in; they
  // cover disjoint trade sets, so adding per (referrer, chain, bps) is correct (a
  // referrer can earn bind volume AND appData volume on the same chain+rate — both
  // count). Keeping the rate per bucket is what lets computeAffiliate take the tier
  // share of the ACTUAL kept fee (5 bps SDK accrues half of 10 bps retail) AND apply
  // the regular cap least-valuable-first within a mixed-rate chain.
  const byReferrer = new Map<
    `0x${string}`,
    Map<string, { chainId: number; grossBps: number; volumeUsd: number }>
  >();
  for (const row of [...rows, ...appdataRows]) {
    const referrer = `0x${row.referrer_hex}` as `0x${string}`;
    const volume = parseFloat(row.volume_usd);
    if (!Number.isFinite(volume) || volume <= 0) continue;
    const grossBps = row.gross_bps;
    let slices = byReferrer.get(referrer);
    if (!slices) {
      slices = new Map();
      byReferrer.set(referrer, slices);
    }
    const key = `${row.chain_id}:${grossBps}`;
    const cur = slices.get(key) ?? { chainId: row.chain_id, grossBps, volumeUsd: 0 };
    cur.volumeUsd += volume;
    slices.set(key, cur);
  }

  const out: AffiliateReferrer[] = [];
  for (const [referrer, slices] of byReferrer) {
    const kind: AffiliateKind = partners.has(referrer) ? 'partner' : 'regular';
    const payoutWallet = payoutByReferrer.get(referrer) ?? null;
    out.push({ referrer_wallet: referrer, kind, buckets: [...slices.values()], payoutWallet });
  }
  return out;
}
