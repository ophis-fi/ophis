import type { Sql } from 'postgres';
import { DECODER_ETHFLOW_OWNERS } from './fetcher.js';

// eth-flow ROUTER contracts (Ophis-dedicated OP/Unichain + canonical CoW prod/barn).
// A native-ETH order settles with owner = one of these, so a router can appear in
// `trades` (the canonical 0xba3c… did, mis-stored by the owner-scoped API fetch). It is
// NOT a person and must be excluded from the public distinct-trader count — while its
// trade rows still count toward volume/trades (they are real settled Ophis volume).
const ROUTER_WALLETS: readonly string[] = Object.freeze([...DECODER_ETHFLOW_OWNERS]);

/**
 * Public cumulative stats shape for GET /stats (JSON + the styled page). Lifetime,
 * lagging-only figures — never current-cycle 30d volume or next-payout timing.
 */
export interface PublicStatsData {
  totalVolumeUsd: number;
  totalTrades: number;
  distinctTraders: number;
  chainsActive: number;
  byChain: { chainId: number; volumeUsd: number; trades: number }[];
  /** Lifetime average over PRICED trades only (AVG ignores NULL value_usd); null until
   *  the first priced trade. */
  avgTradeUsd: number | null;
}

/**
 * Compute the public cumulative stats from the indexed `trades` table, restricted to
 * the given production chain ids (testnet dust never inflates the figures).
 */
export async function computePublicStats(sql: Sql, chainIds: number[]): Promise<PublicStatsData> {
  const totalsRows = await sql<{ vol: string | null; trades: string; traders: string; chains: string; avg_trade: string | null }[]>`
    SELECT
      COALESCE(SUM(value_usd), 0)::text        AS vol,
      COUNT(*)::text                           AS trades,
      -- distinct HUMANS: exclude eth-flow routers (never a person). Volume/trades
      -- above still include the router rows (real settled Ophis volume).
      COUNT(DISTINCT wallet) FILTER (
        WHERE ('0x' || encode(wallet, 'hex')) <> ALL(${ROUTER_WALLETS})
      )::text                                  AS traders,
      COUNT(DISTINCT chain_id)::text           AS chains,
      ROUND(AVG(value_usd)::numeric, 2)::text  AS avg_trade
    FROM trades
    WHERE chain_id = ANY(${chainIds})
  `;
  const byChainRows = await sql<{ chain_id: number; vol: string | null; n: string }[]>`
    SELECT chain_id, COALESCE(SUM(value_usd), 0)::text AS vol, COUNT(*)::text AS n
    FROM trades
    WHERE chain_id = ANY(${chainIds})
    GROUP BY chain_id
    ORDER BY SUM(value_usd) DESC NULLS LAST, COUNT(*) DESC
  `;
  const t = totalsRows[0];
  return {
    totalVolumeUsd: Number(t?.vol ?? '0'),
    totalTrades: Number(t?.trades ?? '0'),
    distinctTraders: Number(t?.traders ?? '0'),
    chainsActive: Number(t?.chains ?? '0'),
    byChain: byChainRows.map((r) => ({ chainId: r.chain_id, volumeUsd: Number(r.vol ?? '0'), trades: Number(r.n) })),
    avgTradeUsd: t?.avg_trade != null ? Number(t.avg_trade) : null,
  };
}
