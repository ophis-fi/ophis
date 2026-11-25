import type { Sql } from 'postgres';
import { ACTIVE_PRODUCTION_CHAIN_IDS, PRODUCTION_CHAIN_IDS } from './stats-page.js';
import { DECODER_ETHFLOW_OWNERS, OPHIS_ETHFLOW_OWNER_BY_CHAIN } from './fetcher.js';
import { settleDecoderChains } from './cow/onchain.js';
import { ARC_CHAIN_ID, SOLANA_MAINNET_ID } from './affiliate/rates.js';

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
  pendingWallets: number;
  incompleteSources: string[];
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

function requiredSources(sql: Sql, chainIds: readonly number[], enrolledThrough: string | null) {
  return sql`
    SELECT c.chain_id, 'wallet' AS source, f.wallet IS NOT NULL AS checked, f.failed, f.last_success_at, f.covered_through
    FROM unnest(${[...chainIds]}::int[]) c(chain_id)
    CROSS JOIN tracked_wallets w
    LEFT JOIN wallet_chain_fetches f ON f.wallet = w.wallet AND f.chain_id = c.chain_id
    WHERE w.first_seen <= COALESCE(${enrolledThrough}::timestamptz, 'infinity'::timestamptz)
      AND ('0x' || encode(w.wallet, 'hex')) <> ALL(${[...DECODER_ETHFLOW_OWNERS]})
    UNION ALL
    SELECT c.chain_id, c.source, f.chain_id IS NOT NULL AS checked, f.failed, f.last_success_at, f.covered_through
    FROM (
      SELECT 'ethflow' AS source, unnest(${Object.keys(OPHIS_ETHFLOW_OWNER_BY_CHAIN).map(Number)}::int[]) AS chain_id
      UNION
      -- Arc needs forward discovery after its reconciliation snapshot.
      SELECT 'decoder', unnest(${[...new Set([...settleDecoderChains(), ARC_CHAIN_ID])]}::int[])
      UNION
      SELECT source, chain_id FROM chain_source_fetches
      WHERE source = 'decoder'
    ) c
    LEFT JOIN chain_source_fetches f ON f.chain_id = c.chain_id AND f.source = c.source
    WHERE c.chain_id = ANY(${[...chainIds]}::int[])
  `;
}

/** Only a completed fetch may publish proof for the wallet cohort enrolled when it started. */
export async function recordCompletedCoverage(sql: Sql, startedAt: string): Promise<void> {
  await sql`
    WITH sources AS (${requiredSources(sql, ACTIVE_PRODUCTION_CHAIN_IDS, startedAt)})
    INSERT INTO chain_scan_coverage (chain_id, covered_through)
    SELECT chain_id, LEAST(min(covered_through), ${startedAt}::timestamptz)
    FROM sources GROUP BY chain_id
    HAVING bool_and(failed IS FALSE AND last_success_at IS NOT NULL AND covered_through IS NOT NULL)
    ON CONFLICT (chain_id) DO UPDATE SET covered_through = EXCLUDED.covered_through
    WHERE chain_scan_coverage.covered_through < EXCLUDED.covered_through
  `;
}

/** Read the durable scorer publication heartbeat. */
export async function readPublicDataFreshness(
  sql: Sql,
  nowMs = Date.now(),
  coverage: 'completed-scan' | 'current-sources' = 'completed-scan',
): Promise<PublicDataFreshness> {
  const chainIds = coverage === 'current-sources' ? PRODUCTION_CHAIN_IDS : ACTIVE_PRODUCTION_CHAIN_IDS;
  const [row] = await sql<{ refreshed_at: string | null }[]>`
    SELECT refreshed_at::text
    FROM public_data_refresh_state
    WHERE singleton = TRUE
  `;
  const sources = await sql<{
    chain_id: number; total: number; checked: number; failed: number; failed_wallets: number; overdue: number;
    last_success_at: string | null; covered_through: string | null; completed_through: string | null; unpriced: number;
    pending_wallets: number; incomplete_sources: string[];
  }[]>`
    WITH sources AS (${requiredSources(sql, chainIds, null)})
    SELECT a.chain_id, count(c.source)::int AS total, count(*) FILTER (WHERE c.checked)::int AS checked,
      count(*) FILTER (WHERE c.failed)::int AS failed,
      count(*) FILTER (WHERE c.failed AND c.source = 'wallet')::int AS failed_wallets,
      count(*) FILTER (WHERE c.covered_through IS NULL OR c.covered_through <
        ${new Date(nowMs - 2 * refreshIntervalMs()).toISOString()}::timestamptz)::int AS overdue,
      count(*) FILTER (WHERE c.source = 'wallet' AND c.failed IS NOT TRUE AND c.covered_through IS NULL)::int AS pending_wallets,
      COALESCE(array_agg(c.source ORDER BY c.source) FILTER (WHERE c.source <> 'wallet'
        AND (c.failed IS NOT FALSE OR c.covered_through IS NULL)), '{}'::text[]) AS incomplete_sources,
      sc.covered_through::text AS completed_through,
      min(c.last_success_at)::text AS last_success_at,
      CASE WHEN count(*) FILTER (WHERE c.covered_through IS NULL) = 0
        THEN min(c.covered_through)::text END AS covered_through,
      (SELECT count(*)::int FROM trades t WHERE t.chain_id = a.chain_id AND t.value_usd IS NULL) AS unpriced
    FROM unnest(${[...chainIds]}::int[]) a(chain_id)
    LEFT JOIN sources c ON c.chain_id = a.chain_id
    LEFT JOIN chain_scan_coverage sc ON sc.chain_id = a.chain_id
    GROUP BY a.chain_id, sc.covered_through
    UNION ALL
    SELECT ${SOLANA_MAINNET_ID}::int, 1, (covered_block_timestamp IS NOT NULL)::int, 0, 0,
      (covered_block_timestamp < ${new Date(nowMs - 2 * refreshIntervalMs()).toISOString()}::timestamptz)::int,
      0, '{}'::text[], covered_block_timestamp::text, checked_at::text, covered_block_timestamp::text,
      (SELECT count(*)::int FROM solana_settled_fills WHERE value_usd IS NULL)
    FROM solana_fill_sync
    WHERE singleton AND (checked_at IS NOT NULL OR ${Boolean(process.env.SOLANA_REPORTING_DATABASE_URL)})
    ORDER BY chain_id
  `;
  const dataSources: PublicDataSource[] = sources.map((s) => {
    const through = coverage === 'current-sources' ? s.covered_through : s.completed_through;
    return {
      chainId: s.chain_id,
      status: s.total === 0 ? 'pending' : s.failed === s.total ? 'unavailable' : s.failed > 0 || s.unpriced > 0 ? 'partial'
        : s.checked < s.total || !s.covered_through || !through ? 'pending'
        : s.overdue > 0 || Date.parse(through) < nowMs - 2 * refreshIntervalMs() ? 'stale' : 'fresh',
      lastSuccessAt: s.last_success_at,
      coveredThrough: through ?? null,
      failedWallets: s.failed_wallets,
      pendingWallets: s.pending_wallets,
      incompleteSources: s.incomplete_sources,
      unpricedTrades: s.unpriced,
    };
  });
  const freshness = assessPublicDataFreshness(row?.refreshed_at ?? null, nowMs);
  if (freshness.dataFresh && dataSources.some((s) => s.status !== 'fresh')) {
    return { ...freshness, dataFresh: false, dataStatus: 'degraded', dataStaleReason: 'ingestion_incomplete', dataSources };
  }
  return { ...freshness, dataSources };
}
