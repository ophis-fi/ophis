import { sql } from '../db/index.js';
import type { AffiliateReferrer } from './computeAffiliate.js';
import type { AffiliateKind } from './rates.js';

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
// bucketed by chain so computeAffiliate can apply the per-chain net-fee rate and the
// OP-first cap. Today every indexed trade is on a hosted chain (Optimism is not
// indexed); the bucketing is OP-ready for when OP indexing ships.

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

  const rows = await sql<{ referrer_hex: string; chain_id: number; volume_usd: string }[]>`
    SELECT
      encode(r.referrer_wallet, 'hex') AS referrer_hex,
      t.chain_id                       AS chain_id,
      SUM(t.value_usd)::text           AS volume_usd
    FROM referrals r
    JOIN trades t ON t.wallet = r.referred_wallet
    WHERE t.block_timestamp >= ${monthStart.toISOString()}
      AND t.block_timestamp <  ${monthEnd.toISOString()}
      AND t.block_timestamp >= r.bound_at
      AND t.value_usd IS NOT NULL
    GROUP BY r.referrer_wallet, t.chain_id
  `;

  // referrer -> (chainId -> volumeUsd)
  const byReferrer = new Map<`0x${string}`, Map<number, number>>();
  for (const row of rows) {
    const referrer = `0x${row.referrer_hex}` as `0x${string}`;
    const volume = parseFloat(row.volume_usd);
    if (!Number.isFinite(volume) || volume <= 0) continue;
    let chains = byReferrer.get(referrer);
    if (!chains) {
      chains = new Map();
      byReferrer.set(referrer, chains);
    }
    chains.set(row.chain_id, (chains.get(row.chain_id) ?? 0) + volume);
  }

  const out: AffiliateReferrer[] = [];
  for (const [referrer, volumeByChain] of byReferrer) {
    const kind: AffiliateKind = partners.has(referrer) ? 'partner' : 'regular';
    const payoutWallet = payoutByReferrer.get(referrer) ?? null;
    out.push({ referrer_wallet: referrer, kind, volumeByChain, payoutWallet });
  }
  return out;
}
