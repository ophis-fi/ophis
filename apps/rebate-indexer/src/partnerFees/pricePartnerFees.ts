import { sql } from '../db/index.js';
import { priceTrade } from '../pricer.js';
import { alerts } from '../telegram/alerter.js';
import { logger } from '../logger.js';

const log = logger.child({ module: 'partner-fee-pricer' });

// Per-fee valuation ceiling (USD) on the PAYOUT basis. The rebate pricer clamps anomalies
// (REBATE_MAX_TRADE_USD) because there they only skew a zero-sum pool share; here fee_usd is
// money PAID from the Safe, so an anomalous quote is quarantined (left unpriced, accrual
// blocked) rather than clamped. Default is generous: a single settlement's collected fee at
// 5-30 bps only reaches $10k around $3M+ of volume in one fill.
const DEFAULT_MAX_FEE_USD = 10_000;

/** Resolve + VALIDATE PARTNER_FEE_MAX_FEE_USD (fail-loud: `x > NaN` is always false). */
export function resolvePartnerFeeMaxFeeUsd(): number {
  const raw = process.env.PARTNER_FEE_MAX_FEE_USD;
  if (raw === undefined || raw.trim() === '') return DEFAULT_MAX_FEE_USD;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`PARTNER_FEE_MAX_FEE_USD must be a finite positive number; got "${raw}"`);
  }
  return n;
}

// Price the collected fee of each unpriced partner-fee trade into fee_usd (partner-fees
// Phase B). Reuses the existing CoW native_price pricer (src/pricer.ts): the fee is priced
// exactly like any trade sell -- priceTrade(chainId, feeToken, feeAmount). A per-trade failure
// (illiquid fee token, transient CoW outage) leaves fee_usd NULL and is retried next run
// (same fail-safe as runPricer), and the payout basis simply excludes an unpriced fee (it
// under-counts rather than mis-prices). value_usd is a reporting-only estimate of the trade
// volume implied by the fee and the bps.

/**
 * Price every unpriced partner-fee trade (fee_usd IS NULL), keyset-paginated by the
 * (trade_uid, recipient) primary key so a per-row failure can't block priceable rows behind
 * it and the loop always terminates (the cursor strictly advances on every row, priced or
 * not). Returns counts.
 */
export async function runPartnerFeePricer(): Promise<{ priced: number; failed: number; anomalous: number }> {
  const refPriceCache = new Map<number, number>(); // chain -> USD-ref native_price, per run
  const maxFeeUsd = resolvePartnerFeeMaxFeeUsd();
  let priced = 0;
  let failed = 0;
  let anomalous = 0;
  // Keyset cursor over the FULL primary key (trade_uid, recipient, chain_id, block_number,
  // log_index): (trade_uid, recipient) alone is NOT unique now that a partiallyFillable order's
  // multiple settlements each persist, so a narrower cursor could loop or skip rows.
  let cUid: Buffer = Buffer.alloc(0); // empty bytea sorts before every trade_uid
  let cRecipient: Buffer = Buffer.alloc(0);
  let cChain = -1;
  let cBlock = -1n;
  let cLog = -1n;

  for (;;) {
    const rows = await sql<{
      trade_uid: Buffer;
      recipient: Buffer;
      chain_id: number;
      block_number: string;
      log_index: string;
      fee_token: Buffer;
      fee_amount: string;
      volume_bps: number;
    }[]>`
      SELECT trade_uid, recipient, chain_id, block_number::text AS block_number, log_index::text AS log_index,
             fee_token, fee_amount::text AS fee_amount, volume_bps
      FROM partner_fee_trades
      WHERE fee_usd IS NULL
        AND (trade_uid, recipient, chain_id, block_number, log_index) > (${cUid}, ${cRecipient}, ${cChain}, ${cBlock.toString()}, ${cLog.toString()})
      ORDER BY trade_uid, recipient, chain_id, block_number, log_index
      LIMIT 1000
    `;
    if (rows.length === 0) break;

    for (const r of rows) {
      cUid = r.trade_uid;
      cRecipient = r.recipient;
      cChain = r.chain_id;
      cBlock = BigInt(r.block_number);
      cLog = BigInt(r.log_index); // advance by full PK regardless of outcome
      try {
        const feeUsd = await priceTrade(
          {
            tradeUid: `0x${r.trade_uid.toString('hex')}` as `0x${string}`,
            chainId: r.chain_id,
            sellToken: `0x${r.fee_token.toString('hex')}` as `0x${string}`,
            sellAmount: BigInt(r.fee_amount),
          },
          refPriceCache,
        );
        // MONEY-PATH VALUATION CAP: fee_usd feeds the WETH-sized Safe payout basis directly,
        // so an anomalous quote for a thin/manipulated fee token must NOT be persisted -- and
        // unlike the rebate pricer's clamp (a zero-sum pool share), clamping here would still
        // OVERPAY a fabricated value from the Safe. QUARANTINE instead: leave the row unpriced
        // (fail-closed -- the accrual completeness gate blocks the cycle) and alert, so a
        // distorted quote becomes an operator incident, never a payout.
        if (feeUsd > maxFeeUsd) {
          anomalous++;
          log.error(
            { tradeUid: `0x${r.trade_uid.toString('hex')}`, chainId: r.chain_id, feeUsd, maxFeeUsd },
            'partner-fee valuation ANOMALOUS (exceeds PARTNER_FEE_MAX_FEE_USD); left unpriced for investigation',
          );
          await alerts
            .alert(
              'partner-fee-pricer',
              `Partner-fee trade 0x${r.trade_uid.toString('hex')} priced at $${feeUsd.toFixed(2)} — above the ${maxFeeUsd} USD single-fee cap. LEFT UNPRICED (accrual blocked) pending investigation; raise PARTNER_FEE_MAX_FEE_USD only if the fee is genuine.`,
            )
            .catch(() => {});
          continue;
        }
        // Reporting-only implied trade volume: fee_usd / (bps/1e4). Only when bps > 0.
        const valueUsd = r.volume_bps > 0 ? (feeUsd * 10_000) / r.volume_bps : null;
        await sql`
          UPDATE partner_fee_trades
          SET fee_usd = ${feeUsd}, value_usd = ${valueUsd}, priced_at = now()
          WHERE trade_uid = ${r.trade_uid} AND recipient = ${r.recipient}
            AND chain_id = ${r.chain_id} AND block_number = ${r.block_number} AND log_index = ${r.log_index}
        `;
        priced++;
      } catch (err) {
        log.warn({ err, tradeUid: `0x${r.trade_uid.toString('hex')}` }, 'partner-fee pricing failed (retried next run)');
        failed++;
      }
    }
  }

  log.info({ priced, failed, anomalous }, 'partner-fee pricer complete');
  return { priced, failed, anomalous };
}
