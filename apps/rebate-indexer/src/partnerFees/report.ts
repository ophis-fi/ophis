import { sql } from '../db/index.js';
import { PARTNER_FEE_PARTNER_SHARE_BPS, MIN_PARTNER_PAYOUT_USD } from './split.js';

// Read-only reporting for the signature-gated partner dashboard (POST /partner-fees) and the
// optional public GET /partner-fees/stats (partner-fees Phase B). No money movement here.

/** 1st of next month, 02:00 UTC (when the monthly partner batcher next runs). */
export function nextPartnerPayoutAt(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 2, 0, 0));
}

export interface PartnerFeeDashboard {
  readonly recipient: `0x${string}`;
  /** Current (not-yet-accounted) cycle. */
  readonly currentCycle: {
    /** Σ collected fee USD priced so far this cycle (before the 80% split). */
    readonly grossFeeUsd: number;
    /** The 80% partner share of grossFeeUsd. */
    readonly partnerShareUsd: number;
    /** USD carried in from prior sub-threshold cycles. */
    readonly carriedInUsd: number;
    /** partnerShareUsd + carriedInUsd = what would be owed if the cycle closed now. */
    readonly owedUsd: number;
    /** Unpriced trades still pending (excluded from the figures above until priced). */
    readonly pendingUnpricedTrades: number;
  };
  readonly lifetime: {
    /** WETH actually paid across all executed batches. */
    readonly paidWeth: number;
    /** Number of trades ever attributed to this recipient. */
    readonly tradeCount: number;
  };
  /** Most recent batch entries for this recipient (newest first). */
  readonly recentBatches: {
    readonly cycleMonth: string;
    readonly status: string;
    readonly owedUsd: number;
    readonly owedWeth: number;
    readonly carriedUsd: number;
  }[];
  readonly nextPayoutAt: string;
  readonly minPayoutUsd: number;
  readonly partnerShareBps: number;
}

/**
 * Build a partner recipient's dashboard. `recipient` is the recovered, verified signer (the
 * caller already proved ownership), so a partner only ever sees their OWN figures. Numbers
 * mirror the payout math exactly (80% of priced collected fees + carry), so what a partner
 * sees is what the monthly batcher would pay.
 */
export async function getPartnerFeeDashboard(recipient: `0x${string}`, now: Date = new Date()): Promise<PartnerFeeDashboard> {
  const buf = Buffer.from(recipient.slice(2), 'hex');

  // Current cycle = the not-yet-accounted trades (batch_id IS NULL). Priced feed into the
  // owed figure; unpriced are surfaced as pending.
  const [cur] = await sql<{ gross_fee_usd: string; pending: string }[]>`
    SELECT
      COALESCE(SUM(fee_usd), 0)::text AS gross_fee_usd,
      COUNT(*) FILTER (WHERE fee_usd IS NULL)::text AS pending
    FROM partner_fee_trades WHERE recipient = ${buf} AND batch_id IS NULL
  `;
  const grossFeeUsd = parseFloat(cur?.gross_fee_usd ?? '0');
  const partnerShareUsd = (grossFeeUsd * PARTNER_FEE_PARTNER_SHARE_BPS) / 10_000;

  // Carry from the recipient's LATEST entry, iff it is carried/quarantined.
  const [carryRow] = await sql<{ carried_usd: string }[]>`
    WITH latest AS (
      SELECT e.status, e.carried_usd
      FROM partner_fee_batch_entries e
      JOIN partner_fee_batches b ON b.id = e.batch_id
      WHERE e.recipient = ${buf}
      ORDER BY b.cycle_month DESC, b.id DESC
      LIMIT 1
    )
    SELECT COALESCE(carried_usd, 0)::text AS carried_usd FROM latest WHERE status IN ('carried', 'quarantined')
  `;
  const carriedInUsd = parseFloat(carryRow?.carried_usd ?? '0');

  const [life] = await sql<{ paid_weth: string; trade_count: string }[]>`
    SELECT
      COALESCE((SELECT SUM(paid_wei::numeric) / 1e18 FROM partner_fee_batch_entries WHERE recipient = ${buf} AND paid_wei IS NOT NULL), 0)::text AS paid_weth,
      (SELECT COUNT(*) FROM partner_fee_trades WHERE recipient = ${buf})::text AS trade_count
  `;

  const recent = await sql<{ cycle_month: string; status: string; owed_usd: string; owed_wei: string; carried_usd: string }[]>`
    SELECT b.cycle_month::text AS cycle_month, e.status, e.owed_usd::text AS owed_usd, e.owed_wei::text AS owed_wei, e.carried_usd::text AS carried_usd
    FROM partner_fee_batch_entries e
    JOIN partner_fee_batches b ON b.id = e.batch_id
    WHERE e.recipient = ${buf}
    ORDER BY b.cycle_month DESC, b.id DESC
    LIMIT 12
  `;

  return {
    recipient,
    currentCycle: {
      grossFeeUsd,
      partnerShareUsd,
      carriedInUsd,
      owedUsd: partnerShareUsd + carriedInUsd,
      pendingUnpricedTrades: parseInt(cur?.pending ?? '0', 10),
    },
    lifetime: {
      paidWeth: parseFloat(life?.paid_weth ?? '0'),
      tradeCount: parseInt(life?.trade_count ?? '0', 10),
    },
    recentBatches: recent.map((r) => ({
      cycleMonth: r.cycle_month.slice(0, 7),
      status: r.status,
      owedUsd: parseFloat(r.owed_usd),
      owedWeth: Number(BigInt(r.owed_wei)) / 1e18,
      carriedUsd: parseFloat(r.carried_usd),
    })),
    nextPayoutAt: nextPartnerPayoutAt(now).toISOString(),
    minPayoutUsd: MIN_PARTNER_PAYOUT_USD,
    partnerShareBps: PARTNER_FEE_PARTNER_SHARE_BPS,
  };
}

export interface PartnerFeeStats {
  /** Distinct partner recipients ever attributed a fee. */
  readonly partners: number;
  /** WETH paid to partners across all executed batches. */
  readonly paidWeth: number;
  /** Priced collected-fee USD not yet paid (current cycle + carry). */
  readonly pendingOwedUsd: number;
}

/** Aggregate, non-wallet-scoped public stats. Safe to expose (no per-partner detail). */
export async function getPartnerFeeStats(): Promise<PartnerFeeStats> {
  const [row] = await sql<{ partners: string; paid_weth: string; pending_owed_usd: string }[]>`
    SELECT
      (SELECT COUNT(DISTINCT recipient) FROM partner_fee_trades)::text AS partners,
      COALESCE((SELECT SUM(paid_wei::numeric) / 1e18 FROM partner_fee_batch_entries WHERE paid_wei IS NOT NULL), 0)::text AS paid_weth,
      COALESCE((SELECT SUM(fee_usd) * ${PARTNER_FEE_PARTNER_SHARE_BPS} / 10000 FROM partner_fee_trades WHERE batch_id IS NULL AND fee_usd IS NOT NULL), 0)::text AS pending_owed_usd
  `;
  return {
    partners: parseInt(row?.partners ?? '0', 10),
    paidWeth: parseFloat(row?.paid_weth ?? '0'),
    pendingOwedUsd: parseFloat(row?.pending_owed_usd ?? '0'),
  };
}
