import type { Sql } from 'postgres';
import { PRODUCTION_CHAIN_IDS } from './stats-page.js';
import { DECODER_ETHFLOW_OWNERS, OPHIS_ETHFLOW_OWNER_BY_CHAIN } from './fetcher.js';
import { settleDecoderChains } from './cow/onchain.js';
import { ARC_CHAIN_ID } from './affiliate/rates.js';

/** Shared by the scheduler and its public freshness checks. */
export function refreshIntervalMs(): number {
  const raw = process.env['REBATES_REFRESH_MINUTES'];
  const mins = raw === undefined ? 60 : Number(raw);
  // The scheduler polls every ten minutes.
  if (!Number.isFinite(mins) || mins < 10 || mins > 24 * 60) return 60 * 60_000;
  return Math.floor(mins) * 60_000;
}

export type PublicDataStaleReason = 'never_refreshed' | 'refresh_overdue' | 'invalid_refresh_timestamp' | 'ingestion_incomplete';

export interface PublicDataSource {
  chainId: number;
  status: 'fresh' | 'partial' | 'unavailable' | 'pending' | 'stale';
  lastSuccessAt: string | null;
  coveredThrough: string | null;
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

/** Allow one scheduled refresh interval plus one interval of grace.
 * Planned quiet windows still expose aging data as stale.
 * `dataAsOf` is the completed scorer publication time, not source coverage. */
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

  const dataFresh = nowMs - refreshedMs <= 2 * refreshIntervalMs();
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
    chain_id: number; total: number; checked: number; failed: number; failed_wallets: number; overdue: number;
    last_success_at: string | null; covered_through: string | null; unpriced: number;
  }[]>`
    WITH sources AS (
      SELECT c.chain_id, true AS is_wallet, f.wallet IS NOT NULL AS checked, f.failed, f.last_success_at, f.covered_through
      FROM unnest(${[...PRODUCTION_CHAIN_IDS]}::int[]) c(chain_id)
      CROSS JOIN tracked_wallets w
      LEFT JOIN wallet_chain_fetches f ON f.wallet = w.wallet AND f.chain_id = c.chain_id
      WHERE ('0x' || encode(w.wallet, 'hex')) <> ALL(${[...DECODER_ETHFLOW_OWNERS]})
      UNION ALL
      SELECT c.chain_id, false AS is_wallet, f.chain_id IS NOT NULL AS checked, f.failed, f.last_success_at, f.covered_through
      FROM (
        SELECT 'ethflow' AS source, unnest(${Object.keys(OPHIS_ETHFLOW_OWNER_BY_CHAIN).map(Number)}::int[]) AS chain_id
        UNION
        -- Arc needs forward discovery after its reconciliation snapshot.
        SELECT 'decoder', unnest(${[...new Set([...settleDecoderChains(), ARC_CHAIN_ID])]}::int[])
        UNION
        SELECT source, chain_id FROM chain_source_fetches
        WHERE source = 'decoder' AND chain_id = ANY(${[...PRODUCTION_CHAIN_IDS]})
      ) c
      LEFT JOIN chain_source_fetches f ON f.chain_id = c.chain_id AND f.source = c.source
    )
    SELECT c.chain_id, count(*)::int AS total, count(*) FILTER (WHERE c.checked)::int AS checked,
      count(*) FILTER (WHERE c.failed)::int AS failed,
      count(*) FILTER (WHERE c.failed AND c.is_wallet)::int AS failed_wallets,
      count(*) FILTER (WHERE c.covered_through IS NULL OR c.covered_through <
        ${new Date(nowMs - 2 * refreshIntervalMs()).toISOString()}::timestamptz)::int AS overdue,
      min(c.last_success_at)::text AS last_success_at,
      CASE WHEN count(*) FILTER (WHERE c.covered_through IS NULL) = 0
        THEN min(c.covered_through)::text END AS covered_through,
      (SELECT count(*)::int FROM trades t WHERE t.chain_id = c.chain_id AND t.value_usd IS NULL) AS unpriced
    FROM sources c
    GROUP BY c.chain_id ORDER BY c.chain_id
  `;
  const dataSources: PublicDataSource[] = sources.map((s) => ({
    chainId: s.chain_id,
    status: s.checked < s.total ? 'pending' : s.failed === s.total ? 'unavailable'
      : s.failed > 0 || s.unpriced > 0 ? 'partial' : s.overdue > 0 ? 'stale' : 'fresh',
    lastSuccessAt: s.last_success_at,
    coveredThrough: s.covered_through ?? null,
    failedWallets: s.failed_wallets,
    unpricedTrades: s.unpriced,
  }));
  const freshness = assessPublicDataFreshness(row?.refreshed_at ?? null, nowMs);
  if (freshness.dataFresh && dataSources.some((s) => s.status !== 'fresh')) {
    return { ...freshness, dataFresh: false, dataStatus: 'degraded', dataStaleReason: 'ingestion_incomplete', dataSources };
  }
  return { ...freshness, dataSources };
}
