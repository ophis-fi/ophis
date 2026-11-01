import type { Sql } from 'postgres';
import { PRODUCTION_CHAIN_IDS } from './stats-page.js';

/** Daily publication runs at 02:00 UTC. Two hours of grace avoids a false alarm
 * while a slow backfill/pricing pass finishes, while still paging on the same day. */
export const PUBLIC_DATA_MAX_AGE_MS = 26 * 60 * 60 * 1000;

export type PublicDataStaleReason = 'never_refreshed' | 'refresh_overdue' | 'invalid_refresh_timestamp' | 'ingestion_incomplete';

export interface PublicDataSource {
  chainId: number;
  status: 'fresh' | 'partial' | 'unavailable' | 'pending' | 'stale';
  lastSuccessAt: string | null;
  failedWallets: number;
  unpricedTrades: number;
}

export interface PublicDataFreshness {
  dataAsOf: string | null;
  dataFresh: boolean;
  dataStatus: 'fresh' | 'degraded';
  dataStaleReason: PublicDataStaleReason | null;
  dataSources?: PublicDataSource[];
}

/** Pure freshness assessment, kept separate from the database read for exact
 * boundary and clock tests. `dataAsOf` is the completed scorer publication time. */
export function assessPublicDataFreshness(
  refreshedAt: string | null,
  nowMs = Date.now(),
): PublicDataFreshness {
  if (!refreshedAt) {
    return {
      dataAsOf: null,
      dataFresh: false,
      dataStatus: 'degraded',
      dataStaleReason: 'never_refreshed',
    };
  }

  const refreshedMs = Date.parse(refreshedAt);
  if (!Number.isFinite(refreshedMs)) {
    return {
      dataAsOf: refreshedAt,
      dataFresh: false,
      dataStatus: 'degraded',
      dataStaleReason: 'invalid_refresh_timestamp',
    };
  }

  const dataFresh = nowMs - refreshedMs <= PUBLIC_DATA_MAX_AGE_MS;
  return {
    dataAsOf: refreshedAt,
    dataFresh,
    dataStatus: dataFresh ? 'fresh' : 'degraded',
    dataStaleReason: dataFresh ? null : 'refresh_overdue',
  };
}

/** Read the durable scorer publication heartbeat. */
export async function readPublicDataFreshness(
  sql: Sql,
  nowMs = Date.now(),
): Promise<PublicDataFreshness> {
  const [row] = await sql<{ refreshed_at: string | null }[]>`
    SELECT refreshed_at::text
    FROM public_data_refresh_state
    WHERE singleton = TRUE
  `;
  const sources = await sql<{
    chain_id: number; total: number; checked: number; failed: number; overdue: number;
    last_success_at: string | null; unpriced: number;
  }[]>`
    SELECT c.chain_id, count(w.wallet)::int AS total, count(f.wallet)::int AS checked,
      count(*) FILTER (WHERE f.failed)::int AS failed,
      count(*) FILTER (WHERE f.last_success_at IS NULL OR f.last_success_at <
        ${new Date(nowMs - PUBLIC_DATA_MAX_AGE_MS).toISOString()}::timestamptz)::int AS overdue,
      min(f.last_success_at)::text AS last_success_at,
      (SELECT count(*)::int FROM trades t WHERE t.chain_id = c.chain_id AND t.value_usd IS NULL) AS unpriced
    FROM unnest(${[...PRODUCTION_CHAIN_IDS]}::int[]) c(chain_id)
    CROSS JOIN tracked_wallets w
    LEFT JOIN wallet_chain_fetches f ON f.wallet = w.wallet AND f.chain_id = c.chain_id
    GROUP BY c.chain_id ORDER BY c.chain_id
  `;
  const dataSources: PublicDataSource[] = sources.map((s) => ({
    chainId: s.chain_id,
    status: s.checked < s.total ? 'pending' : s.failed === s.total ? 'unavailable'
      : s.failed > 0 || s.unpriced > 0 ? 'partial' : s.overdue > 0 ? 'stale' : 'fresh',
    lastSuccessAt: s.last_success_at,
    failedWallets: s.failed,
    unpricedTrades: s.unpriced,
  }));
  const freshness = assessPublicDataFreshness(row?.refreshed_at ?? null, nowMs);
  if (freshness.dataFresh && dataSources.some((s) => s.status !== 'fresh')) {
    return { ...freshness, dataFresh: false, dataStatus: 'degraded', dataStaleReason: 'ingestion_incomplete', dataSources };
  }
  return { ...freshness, dataSources };
}
