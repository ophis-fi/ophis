import { TIERS, assignTier, type Tier } from './tiers.js';

export interface LeaderboardEntry {
  rank: number;
  wallet: `0x${string}`;
  tier: string;
  volume30dUsd: number;
  volumeTotalUsd: number;
  affiliateCount: number;
  referredVolumeUsd: number;
}

export interface LeaderboardResponse {
  updatedAt: string;
  total: number;
  entries: LeaderboardEntry[];
}

export interface RankInfo {
  wallet: `0x${string}`;
  tier: string;
  volume30dUsd: number;
  rebatePct: number;
  nextTier: string | null;
  nextThresholdUsd: number | null;
  toNextUsd: number | null;
  position: number | null;
}

/**
 * Get the next tier after the current one, with thresholds.
 */
export function getNextTierInfo(currentTier: Tier): {
  nextTier: Tier | null;
  nextThresholdUsd: number | null;
} {
  const tierIdx = TIERS.findIndex((t) => t.name === currentTier.name);
  if (tierIdx < 0) {
    return { nextTier: null, nextThresholdUsd: null };
  }
  if (tierIdx >= TIERS.length - 1) {
    return { nextTier: null, nextThresholdUsd: null };
  }
  const next = TIERS[tierIdx + 1]!;
  return { nextTier: next, nextThresholdUsd: next.min_usd };
}

/**
 * Compute tier progress: returns the next tier name and distance to reach it.
 */
export function computeTierProgress(
  volume30dUsd: number,
  currentTier: Tier,
): {
  nextTier: string | null;
  nextThresholdUsd: number | null;
  toNextUsd: number | null;
} {
  const { nextTier, nextThresholdUsd } = getNextTierInfo(currentTier);
  if (!nextTier || nextThresholdUsd === null) {
    return { nextTier: null, nextThresholdUsd: null, toNextUsd: null };
  }
  const toNext = Math.max(0, nextThresholdUsd - volume30dUsd);
  return { nextTier: nextTier.name, nextThresholdUsd, toNextUsd: toNext };
}

/**
 * 60-second in-memory cache for leaderboard data.
 */
let leaderboardCache: { data: LeaderboardResponse; expiresAt: number } | null = null;

/**
 * Fetch leaderboard entries from the database.
 * Computes: per-wallet 30d volume, total volume, affiliate count, referred volume.
 * Returns sorted by volume30dUsd descending with 1-based ranking.
 */
async function fetchLeaderboardEntries(limit: number): Promise<LeaderboardEntry[]> {
  // Import sql here to avoid module-level database connection during test setup
  const { sql } = await import('./db/index.js');

  // Query wallets ranked by 30d volume
  const rows = await sql<
    {
      wallet_hex: string;
      volume_30d_usd: string;
      volume_total_usd: string;
      affiliate_count: string;
      referred_volume_usd: string;
    }[]
  >`
    WITH wallet_volumes AS (
      SELECT
        w.wallet,
        w.volume_30d_usd,
        w.volume_total_usd,
        encode(w.wallet, 'hex') AS wallet_hex
      FROM wallets w
      WHERE w.volume_30d_usd > 0
      ORDER BY w.volume_30d_usd DESC
      LIMIT ${limit}
    ),
    affiliate_counts AS (
      SELECT
        r.referrer_wallet,
        COUNT(DISTINCT r.referred_wallet)::text AS affiliate_count,
        COALESCE(SUM(t.value_usd), 0)::text AS referred_volume_usd
      FROM referrals r
      LEFT JOIN trades t
        ON t.wallet = r.referred_wallet
        AND t.block_timestamp >= r.bound_at
        AND t.value_usd IS NOT NULL
      GROUP BY r.referrer_wallet
    )
    SELECT
      wv.wallet_hex,
      wv.volume_30d_usd::text,
      wv.volume_total_usd::text,
      COALESCE(ac.affiliate_count, '0') AS affiliate_count,
      COALESCE(ac.referred_volume_usd, '0') AS referred_volume_usd
    FROM wallet_volumes wv
    LEFT JOIN affiliate_counts ac ON ac.referrer_wallet = wv.wallet
    ORDER BY wv.volume_30d_usd DESC
  `;

  return rows.map((row, idx) => {
    const volume30d = parseFloat(row.volume_30d_usd);
    const tier = assignTier(volume30d);
    return {
      rank: idx + 1,
      wallet: `0x${row.wallet_hex}` as `0x${string}`,
      tier: tier.name,
      volume30dUsd: volume30d,
      volumeTotalUsd: parseFloat(row.volume_total_usd),
      affiliateCount: parseInt(row.affiliate_count, 10),
      referredVolumeUsd: parseFloat(row.referred_volume_usd),
    };
  });
}

/**
 * Get the leaderboard with caching. Cache hits reset the 60s timer.
 */
export async function getLeaderboard(limit: number): Promise<LeaderboardResponse> {
  const now = Date.now();
  if (leaderboardCache && leaderboardCache.expiresAt > now) {
    return leaderboardCache.data;
  }

  const entries = await fetchLeaderboardEntries(limit);
  const total = entries.length;
  const response: LeaderboardResponse = {
    updatedAt: new Date().toISOString(),
    total,
    entries,
  };

  leaderboardCache = {
    data: response,
    expiresAt: now + 60_000, // 60 seconds
  };

  return response;
}

/**
 * Get rank info for a single wallet: current tier, next tier, and position in leaderboard.
 */
export async function getRankInfo(wallet: `0x${string}`): Promise<RankInfo | null> {
  // Import sql here to avoid module-level database connection during test setup
  const { sql } = await import('./db/index.js');

  const walletBuf = Buffer.from(wallet.slice(2), 'hex');
  const rows = await sql<{ volume_30d_usd: string; rebate_pct: string }[]>`
    SELECT volume_30d_usd::text, (
      CASE
        WHEN volume_30d_usd < 20000 THEN '0.0'
        WHEN volume_30d_usd < 50000 THEN '0.10'
        WHEN volume_30d_usd < 100000 THEN '0.15'
        WHEN volume_30d_usd < 500000 THEN '0.25'
        WHEN volume_30d_usd < 1000000 THEN '0.35'
        ELSE '0.50'
      END
    )::text AS rebate_pct
    FROM wallets
    WHERE wallet = ${walletBuf}
  `;

  if (rows.length === 0) {
    return null;
  }

  const volume30d = parseFloat(rows[0]!.volume_30d_usd);
  const rebatePct = parseFloat(rows[0]!.rebate_pct);

  if (volume30d === 0) {
    // No volume, no position
    const tier = assignTier(0);
    const progress = computeTierProgress(0, tier);
    return {
      wallet,
      tier: tier.name,
      volume30dUsd: 0,
      rebatePct,
      nextTier: progress.nextTier,
      nextThresholdUsd: progress.nextThresholdUsd,
      toNextUsd: progress.toNextUsd,
      position: null,
    };
  }

  // Get position in leaderboard (1-based rank)
  let position: number | null = null;
  const rankRows = await sql<{ position: string }[]>`
    WITH ranked AS (
      SELECT wallet, ROW_NUMBER() OVER (ORDER BY volume_30d_usd DESC) AS position
      FROM wallets
      WHERE volume_30d_usd > 0
    )
    SELECT position::text
    FROM ranked
    WHERE wallet = ${walletBuf}
  `;
  if (rankRows.length > 0) {
    position = parseInt(rankRows[0]!.position, 10);
  }

  const tier = assignTier(volume30d);
  const progress = computeTierProgress(volume30d, tier);

  return {
    wallet,
    tier: tier.name,
    volume30dUsd: volume30d,
    rebatePct,
    nextTier: progress.nextTier,
    nextThresholdUsd: progress.nextThresholdUsd,
    toNextUsd: progress.toNextUsd,
    position,
  };
}
