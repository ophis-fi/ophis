import { TIERS, assignTier, type Tier } from './tiers.js';

/**
 * Truncated display form of an address (0xXXXX...XXXX). The public /leaderboard
 * returns this instead of the full address so the endpoint cannot be used to
 * enumerate full trader addresses (deanonymization). The frontend identifies its
 * own row by truncating the connected wallet the same way.
 */
export function truncateWallet(addr: string): string {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

export interface LeaderboardEntry {
  rank: number;
  /** Truncated display form (0xXXXX...XXXX), NOT the full address (privacy). */
  wallet: string;
  tier: string;
  volume30dUsd: number;
  volumeTotalUsd: number;
  affiliateCount: number;
  referredVolumeUsd: number;
  /**
   * True only on the caller's own row, set when /leaderboard is queried with a
   * `self` address. Present only when `self` was supplied. Matched on the FULL
   * address server-side within the same snapshot, so it is collision-free (unlike
   * the truncated `wallet`) and skew-free (unlike cross-referencing a live rank
   * against this cached snapshot).
   */
  isSelf?: boolean;
}

/**
 * Cached entry: a LeaderboardEntry plus the full lowercase wallet hex (no 0x),
 * kept SERVER-SIDE only for self-matching. `walletHexFull` is stripped before the
 * entry is serialized to a client, so the full address is never exposed.
 */
interface CachedLeaderboardEntry extends LeaderboardEntry {
  walletHexFull: string;
}

/**
 * Mark the caller's own row by FULL-address compare within a single snapshot,
 * then strip the server-only `walletHexFull`. Pure (no I/O) so it is unit-tested
 * directly. With `self` null, returns the public entries unchanged (no isSelf).
 */
export function markSelf(
  entries: CachedLeaderboardEntry[],
  self: string | null,
): LeaderboardEntry[] {
  const selfHex = self ? self.toLowerCase().replace(/^0x/, '') : null;
  return entries.map(({ walletHexFull, ...entry }) =>
    selfHex ? { ...entry, isSelf: walletHexFull === selfHex } : entry,
  );
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
 * 60-second in-memory cache. Holds the full top-MAX_LEADERBOARD snapshot; each
 * request's `limit` slices that snapshot, so the cache is limit-independent (a
 * small first request can't pin a truncated result, nor a large one over-serve).
 */
const MAX_LEADERBOARD = 100;
let leaderboardCache: { entries: CachedLeaderboardEntry[]; updatedAt: string; expiresAt: number } | null = null;

/**
 * Fetch leaderboard entries from the database.
 * Computes: per-wallet 30d volume, total volume, affiliate count, referred volume.
 * Returns sorted by volume30dUsd descending with 1-based ranking.
 */
async function fetchLeaderboardEntries(limit: number): Promise<CachedLeaderboardEntry[]> {
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
        -- the wallets matview is a 30-day rolling view; all-time volume is
        -- aggregated from the trades table.
        COALESCE(tv.volume_total_usd, w.volume_30d_usd) AS volume_total_usd,
        encode(w.wallet, 'hex') AS wallet_hex
      FROM wallets w
      LEFT JOIN (
        SELECT wallet, SUM(value_usd) AS volume_total_usd
        FROM trades
        WHERE value_usd IS NOT NULL
        GROUP BY wallet
      ) tv ON tv.wallet = w.wallet
      WHERE w.volume_30d_usd > 0
      ORDER BY w.volume_30d_usd DESC, w.wallet ASC
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
    ORDER BY wv.volume_30d_usd DESC, wv.wallet ASC
  `;

  return rows.map((row, idx) => {
    const volume30d = parseFloat(row.volume_30d_usd);
    const tier = assignTier(volume30d);
    return {
      rank: idx + 1,
      wallet: truncateWallet(`0x${row.wallet_hex}`),
      // Server-only: the full lowercase hex (no 0x) for collision-free
      // self-matching. Stripped by markSelf() before serialization.
      walletHexFull: row.wallet_hex.toLowerCase(),
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
 *
 * `self` (optional, a full lowercase 0x address validated by the caller) marks
 * the connected wallet's own row via markSelf(). The marking is applied per
 * request AFTER the shared snapshot cache, so the cache stays shared and the
 * full address is never cached or serialized.
 */
export async function getLeaderboard(limit: number, self?: string): Promise<LeaderboardResponse> {
  const now = Date.now();
  if (!leaderboardCache || leaderboardCache.expiresAt <= now) {
    const entries = await fetchLeaderboardEntries(MAX_LEADERBOARD);
    leaderboardCache = {
      entries,
      updatedAt: new Date().toISOString(),
      expiresAt: now + 60_000, // 60 seconds
    };
  }

  const entries = markSelf(leaderboardCache.entries.slice(0, limit), self ?? null);
  return { updatedAt: leaderboardCache.updatedAt, total: entries.length, entries };
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
      SELECT wallet, ROW_NUMBER() OVER (ORDER BY volume_30d_usd DESC, wallet ASC) AS position
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
