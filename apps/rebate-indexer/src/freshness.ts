import type { Sql } from 'postgres';

/** Daily publication runs at 02:00 UTC. Two hours of grace avoids a false alarm
 * while a slow backfill/pricing pass finishes, while still paging on the same day. */
export const PUBLIC_DATA_MAX_AGE_MS = 26 * 60 * 60 * 1000;

export type PublicDataStaleReason = 'never_refreshed' | 'refresh_overdue' | 'invalid_refresh_timestamp';

export interface PublicDataFreshness {
  dataAsOf: string | null;
  dataFresh: boolean;
  dataStatus: 'fresh' | 'degraded';
  dataStaleReason: PublicDataStaleReason | null;
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
  return assessPublicDataFreshness(row?.refreshed_at ?? null, nowMs);
}
