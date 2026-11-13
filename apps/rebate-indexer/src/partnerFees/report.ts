import { sql } from '../db/index.js';
import { PARTNER_FEE_PARTNER_SHARE_BPS, MIN_PARTNER_PAYOUT_USD } from './split.js';

// Read-only reporting for the signature-gated partner dashboard (POST /partner-fees) and the
// optional public GET /partner-fees/stats (partner-fees Phase B). No money movement here.

/**
 * The next monthly partner batcher run: the 1st at 02:00 UTC. On the 1st BETWEEN 00:00 and
 * 02:00 the prior cycle's payout is still due later TODAY, so return today's 02:00 rather
 * than skipping a month ahead.
 */
export function nextPartnerPayoutAt(now: Date = new Date()): Date {
  const todaysRun = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 2, 0, 0));
  if (now.getUTCDate() === 1 && now.getTime() < todaysRun.getTime()) return todaysRun;
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

  // Carry = Σ over the recipient's UNFOLDED carried/quarantined entries (the fold ledger --
  // see liability.ts). Latest-only would understate here exactly where it understated the
  // reservation: independent proposal-time quarantines across catch-up batches are all owed.
  const [carryRow] = await sql<{ carried_usd: string }[]>`
    SELECT COALESCE(SUM(carried_usd), 0)::text AS carried_usd
    FROM partner_fee_batch_entries
    WHERE recipient = ${buf} AND status IN ('carried', 'quarantined') AND folded_into_batch_id IS NULL
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

export interface PartnerTraderFigures {
  readonly trades: number;
  /** Σ value_usd of the priced trades (a reporting estimate). */
  readonly volumeUsd: number;
  /** Trades the nightly pricer has not priced yet (value_usd NULL): in trades, not in volumeUsd. */
  readonly unpriced: number;
}

export interface PartnerTraders {
  /** The 100 largest wallets by volumeUsd (ties by address), largest first. */
  readonly wallets: (PartnerTraderFigures & { readonly wallet: `0x${string}` })[];
  /** Every wallet, not only the 100 listed. */
  readonly totals: PartnerTraderFigures & { readonly walletCount: number };
}

/**
 * The wallets that traded through a partner's integration: the owners of the orders that carried
 * this recipient's fee, lifetime. The owner is bytes 33-52 of the CoW order uid (32-byte digest,
 * 20-byte owner, 4-byte validTo). Not the referral program: no share, no code, no estimate.
 */
export async function getPartnerTraders(recipient: `0x${string}`): Promise<PartnerTraders> {
  const buf = Buffer.from(recipient.slice(2), 'hex');
  // The totals are window sums over every wallet: they run before the LIMIT. ORDER BY names w.
  // because a bare volume_usd would sort the text column of the same name.
  // ponytail: the 100 largest wallets only, so 10 recipients stay near 100 kB; a paged read if a partner needs them all.
  const rows = await sql<{ wallet: string; trades: string; volume_usd: string; unpriced: string; wallet_count: string; all_trades: string; all_volume_usd: string; all_unpriced: string }[]>`
    SELECT '0x' || encode(owner, 'hex') AS wallet, trades::text AS trades, volume_usd::text AS volume_usd, unpriced::text AS unpriced,
      COUNT(*) OVER ()::text AS wallet_count, SUM(trades) OVER ()::text AS all_trades,
      SUM(volume_usd) OVER ()::text AS all_volume_usd, SUM(unpriced) OVER ()::text AS all_unpriced
    FROM (
      SELECT substring(trade_uid from 33 for 20) AS owner, COUNT(*) AS trades,
        COALESCE(SUM(value_usd), 0) AS volume_usd, COUNT(*) FILTER (WHERE value_usd IS NULL) AS unpriced
      FROM partner_fee_trades WHERE recipient = ${buf}
      GROUP BY 1
    ) w
    ORDER BY w.volume_usd DESC, w.owner
    LIMIT 100
  `;
  const all = rows[0];
  return {
    wallets: rows.map((r) => ({ wallet: r.wallet as `0x${string}`, trades: Number(r.trades), volumeUsd: Number(r.volume_usd), unpriced: Number(r.unpriced) })),
    totals: {
      walletCount: Number(all?.wallet_count ?? 0),
      trades: Number(all?.all_trades ?? 0),
      volumeUsd: Number(all?.all_volume_usd ?? 0),
      unpriced: Number(all?.all_unpriced ?? 0),
    },
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
  // pendingOwedUsd = everything owed to partners but not yet PAID on-chain, as three DISJOINT
  // parts (so it does NOT read ~0 right after accrual stamps the trades, and never double-counts
  // the running carry):
  //   (a) in-flight PAID entries in an unexecuted batch (owed_usd) -- accrued + queued but unsettled;
  //   (b) the carried/quarantined ROLLUP: Σ carried_usd over UNFOLDED entries (the fold
  //       ledger, see liability.ts) -- a folded entry's amount lives on in its successor, so
  //       the accumulation is counted once, while independent per-batch quarantines all count;
  //   (c) the not-yet-accrued current-cycle share (unbatched priced trades * 80%).
  // A fee is in exactly one of the three.
  const [row] = await sql<{ partners: string; paid_weth: string; pending_owed_usd: string }[]>`
    SELECT
      (SELECT COUNT(DISTINCT recipient) FROM partner_fee_trades)::text AS partners,
      COALESCE((SELECT SUM(paid_wei::numeric) / 1e18 FROM partner_fee_batch_entries WHERE paid_wei IS NOT NULL), 0)::text AS paid_weth,
      (
        COALESCE((SELECT SUM(e.owed_usd) FROM partner_fee_batch_entries e JOIN partner_fee_batches b ON b.id = e.batch_id WHERE e.status = 'paid' AND b.status <> 'executed'), 0)
        + COALESCE((SELECT SUM(carried_usd) FROM partner_fee_batch_entries
                    WHERE status IN ('carried','quarantined') AND folded_into_batch_id IS NULL), 0)
        + COALESCE((SELECT SUM(fee_usd) * ${PARTNER_FEE_PARTNER_SHARE_BPS} / 10000 FROM partner_fee_trades WHERE batch_id IS NULL AND fee_usd IS NOT NULL), 0)
      )::text AS pending_owed_usd
  `;
  return {
    partners: parseInt(row?.partners ?? '0', 10),
    paidWeth: parseFloat(row?.paid_weth ?? '0'),
    pendingOwedUsd: parseFloat(row?.pending_owed_usd ?? '0'),
  };
}
