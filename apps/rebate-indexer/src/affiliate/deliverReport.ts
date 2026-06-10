import { createPublicClient, http, parseAbi } from 'viem';
import { sql } from '../db/index.js';
import { OPHIS_SAFE_ADDRESS, WETH_BY_CHAIN } from '../safe/addresses.js';
import { priceTrade } from '../pricer.js';
import { buildAffiliateReferrers } from './accrual.js';
import { computeAffiliate } from './computeAffiliate.js';
import { assembleReport } from './report.js';
import { notify } from '../telegram/alerter.js';
import { logger } from '../logger.js';

const log = logger.child({ module: 'report' });
const ERC20 = parseAbi(['function balanceOf(address) view returns (uint256)']);
const GNOSIS = 100;
// Telegram hard-caps a message at 4096 chars; the report is aggregate (per-tier
// counts, not per-recipient) so it stays well under, but truncate defensively.
const TG_LIMIT = 4000;

/** The calendar month being SETTLED when the cron fires on the 1st of `now`'s month:
 *  the PREVIOUS month. e.g. running 2026-07-01 settles 2026-06 (1 Jun → 1 Jul). */
function settledWindow(now: Date): { start: Date; end: Date; label: string } {
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return { start, end, label: start.toISOString().slice(0, 7) };
}

/**
 * Generate + deliver (Telegram) + store the monthly settlement report. Called from
 * the cron AFTER the rebate batcher runs on the 1st, so the latest rebate_batch row
 * is this cycle's. Ground truth for fees = the Safe WETH balance; rebate + affiliate
 * + retained reconcile against it. Fire-and-forget safe: any failure alerts and
 * returns, never throwing into the cron (the report is reporting, not a payout).
 */
export async function deliverMonthlyReport(deps: { rpcUrl: string; now?: Date }): Promise<void> {
  const now = deps.now ?? new Date();
  const { start, end, label } = settledWindow(now);
  try {
    const weth = WETH_BY_CHAIN[GNOSIS];
    if (!weth) throw new Error('no WETH address for Gnosis');
    const client = createPublicClient({ transport: http(deps.rpcUrl) });
    const safeWethBalanceWei = await client.readContract({
      address: weth,
      abi: ERC20,
      functionName: 'balanceOf',
      args: [OPHIS_SAFE_ADDRESS],
    });

    // USD per WETH via the (decimals-correct) pricer: a synthetic 1-WETH sale on Gnosis.
    const wethUsdPrice = await priceTrade({
      tradeUid: `0x${'00'.repeat(56)}` as `0x${string}`,
      chainId: GNOSIS,
      sellToken: weth,
      sellAmount: 10n ** 18n,
    });

    // Rebate pool + recipient count from the rebate batch the batcher just created.
    const [rb] = await sql<{ pool: string; cnt: string }[]>`
      SELECT b.pool_weth_wei::text AS pool, COUNT(e.batch_id)::text AS cnt
      FROM rebate_batches b
      LEFT JOIN rebate_batch_entries e ON e.batch_id = b.id
      GROUP BY b.id, b.pool_weth_wei
      ORDER BY b.id DESC
      LIMIT 1
    `;
    const rebatePoolWei = rb ? BigInt(rb.pool) : 0n;
    const rebateRecipientCount = rb ? parseInt(rb.cnt, 10) : 0;

    // Affiliate owed for the settled month.
    const referrers = await buildAffiliateReferrers(start, end);
    const affiliate = computeAffiliate(referrers, wethUsdPrice);

    // Total indexed volume this period, by chain (attribution view).
    const volRows = await sql<{ chain_id: number; vol: string }[]>`
      SELECT chain_id, COALESCE(SUM(value_usd), 0)::text AS vol
      FROM trades
      WHERE block_timestamp >= ${start} AND block_timestamp < ${end} AND value_usd IS NOT NULL
      GROUP BY chain_id
    `;
    const volumeByChain = new Map<number, number>(volRows.map((r) => [r.chain_id, parseFloat(r.vol)]));

    const report = assembleReport({
      cycleMonth: label,
      periodStart: start,
      periodEnd: end,
      safeWethBalanceWei,
      wethUsdPrice,
      rebatePoolWei,
      rebateRecipientCount,
      affiliate,
      volumeByChain,
    });

    await notify(report.text.length > TG_LIMIT ? report.text.slice(0, TG_LIMIT) + '\n…(truncated)' : report.text);

    await sql`
      INSERT INTO settlement_reports (cycle_month, report_text, safe_weth_wei, rebate_wei, affiliate_wei, retained_wei)
      VALUES (${label}, ${report.text}, ${report.safeWethBalanceWei.toString()}, ${report.rebateWei.toString()},
              ${report.affiliateWei.toString()}, ${report.retainedWei.toString()})
      ON CONFLICT (cycle_month) DO UPDATE SET
        report_text = EXCLUDED.report_text, safe_weth_wei = EXCLUDED.safe_weth_wei,
        rebate_wei = EXCLUDED.rebate_wei, affiliate_wei = EXCLUDED.affiliate_wei,
        retained_wei = EXCLUDED.retained_wei, generated_at = now()
    `;
    log.info({ cycleMonth: label, overflow: report.overflow, affiliatePayees: affiliate.length }, 'monthly report delivered');
  } catch (err) {
    log.error({ err, cycleMonth: label }, 'monthly report delivery failed');
    await notify(`⚠️ Ophis monthly settlement report (${label}) FAILED to generate: ${err instanceof Error ? err.message : String(err)}`).catch(() => {});
  }
}
