/**
 * GET /earnings/:appCode - the keyless, read-only integrator earnings surface.
 *
 * The locked strategy sells own-fee settlement to operators; their first diligence
 * question is "how do I verify what I earned and where it paid out". This module
 * answers it per appCode (the integrator's own identifier tagged into appData, stored
 * as trades.appdata_ref_code - the widget top-level appCode or the SDK
 * metadata.ophisReferrer.code both land there).
 *
 * HARD SCOPING CONSTRAINT (a hostile review flagged this): only Optimism (10) and
 * Unichain (130) are Ophis-operated, where Ophis controls settlement and payout end
 * to end. On the CoW-hosted chains, partner fees are disbursed by CoW's weekly script
 * under CoW's terms; Ophis neither pays nor guarantees them. So the "guaranteed"
 * figures are sovereign-only; hosted figures are ACCRUED (indexed from settlement) and
 * explicitly labeled "accrued at settlement, paid out by CoW under CoW terms; not
 * guaranteed by Ophis", never as Ophis-guaranteed earnings.
 *
 * SECURITY INVARIANT (mirror of stats-page.ts / the admin-only /status route): a
 * public surface must NOT expose current-cycle 30-day volume or next-payout timing
 * (front-runner signals). This per-appCode surface therefore reports CUMULATIVE
 * (lifetime) routed volume and fee accrual, and EXACT paid-to-date referral share from
 * already-executed Safe batches. It never returns a 30d figure, an estimated
 * current-cycle earning, or a next-payout timestamp (those stay sig-gated on /partner).
 */
import { SOVEREIGN_CHAIN_IDS } from './affiliate/rates.js';
import { CHAIN_NAME, PRODUCTION_CHAIN_IDS } from './stats-page.js';

// db (sql) is imported LAZILY inside getIntegratorEarnings so this module - and the
// PURE assembleEarnings below - can be loaded without DATABASE_URL set (same pattern
// as fetcher.ts). The unit tests exercise assembleEarnings without a database.

/** bps -> fraction denominator: USD fee = SUM(value_usd * bps) / 10_000. */
const BPS_DENOM = 10_000;

/**
 * The chain the monthly affiliate/referral payout Safe executes on (Gnosis). The
 * affiliate MultiSend pays WETH from the single Gnosis Safe (see affiliate/payout.ts,
 * WETH_BY_CHAIN), so an executed payout tx is a Gnosis transaction. Ophis proposes,
 * signs (2-of-3), and executes it, so it is an Ophis-controlled payout regardless of
 * which chain the underlying volume routed on.
 */
const AFFILIATE_PAYOUT_CHAIN_ID = 100;

/** Block-explorer tx-URL builders for the chains a payout can land on. */
const EXPLORER_TX_URL: Record<number, (txHash: string) => string> = {
  100: (tx) => `https://gnosisscan.io/tx/${tx}`,
};

function explorerTxUrl(chainId: number, txHash: string): string | null {
  return EXPLORER_TX_URL[chainId]?.(txHash) ?? null;
}

/** Trim float artifacts (value_usd is 4-dp; dividing by bps can add noise). */
function round(n: number, dp = 6): number {
  if (!Number.isFinite(n)) return 0;
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

// --- Response shape ---------------------------------------------------------

export interface EarningsChainRow {
  chainId: number;
  chainName: string;
  /** true for Optimism (10) and Unichain (130): Ophis controls payout end to end. */
  sovereign: boolean;
  routedVolumeUsd: number;
  trades: number;
  /** Gross Ophis partner fee charged on this integrator's flow on this chain (info). */
  ophisFeeAccruedUsd: number;
  /** The integrator's own stacked fee on this chain. */
  ownFeeAccruedUsd: number;
}

export interface EarningsPayout {
  cycleMonth: string; // 'YYYY-MM' (settled month the payout covered)
  chainId: number;
  chainName: string;
  txHash: `0x${string}`;
  explorerUrl: string | null;
  amountWeth: number;
}

export interface IntegratorEarnings {
  appCode: string;
  generatedAt: string; // ISO
  /** The Ophis-operated chains whose figures Ophis guarantees end to end. */
  sovereignChains: number[];
  /** Top-level plain-language scoping statement (deliverable requirement). */
  disclaimer: string;
  /** CUMULATIVE (lifetime) routed volume, split sovereign vs hosted. Never a 30d figure. */
  routedVolumeUsd: { total: number; sovereign: number; hosted: number };
  /** Gross Ophis partner fee charged on this flow (informational, not the integrator's earning). */
  ophisFeeAccruedUsd: { total: number; sovereign: number; hosted: number };
  /** The integrator's OWN stacked fee. sovereignGuaranteed is Ophis-controlled; hostedAccrued is CoW-disbursed. */
  ownFeeAccruedUsd: {
    total: number;
    sovereignGuaranteed: number;
    hostedAccrued: number;
    /** Most recent own-fee recipient seen on this integrator's flow (where it paid out). */
    recipient: `0x${string}` | null;
    note: string;
  };
  /** Referral rebate Ophis pays this integrator's wallet monthly (only if the appCode is a registered code). */
  referral: {
    registered: boolean;
    /** EXACT, from already-executed Ophis Safe batches. Not an estimate, not current-cycle. */
    paidToDateWeth: number;
    paidToDateUsd: number;
    payouts: EarningsPayout[];
    note: string;
  };
  byChain: EarningsChainRow[];
}

// --- Pure assembler (unit-testable with mock DB rows) -----------------------

export interface EarningsChainInput {
  chainId: number;
  /** SUM(value_usd) for this appCode on this chain (USD). */
  volumeUsd: number;
  trades: number;
  /** SUM(value_usd * volume_fee_bps) - i.e. USD*bps; assembler divides by 10_000. */
  ophisFeeBase: number;
  /** SUM(value_usd * own_fee_bps) - USD*bps; assembler divides by 10_000. */
  ownFeeBase: number;
}

export interface EarningsPayoutInput {
  cycleMonth: string; // 'YYYY-MM-DD' (date) from affiliate_batches.cycle_month
  txHash: `0x${string}`;
  paidWei: string; // decimal string (uint256)
  wethUsd: number | null;
}

export interface EarningsInput {
  byChain: EarningsChainInput[];
  /** Most recent own_fee_recipient seen for this appCode (0x, lowercased), or null. */
  ownFeeRecipient: `0x${string}` | null;
  /** True when the appCode is a registered ref code (so a referral rebate can accrue). */
  registered: boolean;
  /** Executed, paid affiliate batch entries for the code's referrer wallet. */
  payouts: EarningsPayoutInput[];
}

const HOSTED_ACCRUAL_LABEL =
  'accrued at settlement, paid out by CoW under CoW terms; not guaranteed by Ophis';

/**
 * Build the earnings response from already-fetched rows. Pure - no DB - so tests can
 * assert the sovereign/hosted scoping, the disclaimer, the own-fee guarantee split,
 * and the absence of any 30d/next-cycle leak without a database.
 */
export function assembleEarnings(appCode: string, input: EarningsInput, now: Date): IntegratorEarnings {
  const sovereignChains = [...SOVEREIGN_CHAIN_IDS].sort((a, b) => a - b);

  const byChain: EarningsChainRow[] = input.byChain
    .map((c) => {
      const sovereign = SOVEREIGN_CHAIN_IDS.has(c.chainId);
      return {
        chainId: c.chainId,
        chainName: CHAIN_NAME[c.chainId] ?? `Chain ${c.chainId}`,
        sovereign,
        routedVolumeUsd: round(c.volumeUsd, 4),
        trades: c.trades,
        ophisFeeAccruedUsd: round(c.ophisFeeBase / BPS_DENOM),
        ownFeeAccruedUsd: round(c.ownFeeBase / BPS_DENOM),
      };
    })
    // Largest routed volume first, then chain id for stable ordering.
    .sort((a, b) => b.routedVolumeUsd - a.routedVolumeUsd || a.chainId - b.chainId);

  // Split every total sovereign vs hosted off the SAME per-chain rows so the halves
  // always reconcile to the totals (no separate SQL that could drift).
  let volSov = 0;
  let volHosted = 0;
  let ophisSov = 0;
  let ophisHosted = 0;
  let ownSov = 0;
  let ownHosted = 0;
  for (const c of byChain) {
    if (c.sovereign) {
      volSov += c.routedVolumeUsd;
      ophisSov += c.ophisFeeAccruedUsd;
      ownSov += c.ownFeeAccruedUsd;
    } else {
      volHosted += c.routedVolumeUsd;
      ophisHosted += c.ophisFeeAccruedUsd;
      ownHosted += c.ownFeeAccruedUsd;
    }
  }

  // Referral paid-to-date: EXACT, summed from already-executed Safe batches. Weighted
  // to USD by each batch's recorded WETH price (0 when a batch has no price, so it
  // never fabricates a USD figure).
  let paidWeiTotal = 0n;
  let paidUsd = 0;
  const payouts: EarningsPayout[] = [];
  for (const p of input.payouts) {
    let wei: bigint;
    try {
      wei = BigInt(p.paidWei);
    } catch {
      continue; // skip a malformed amount rather than poison the total
    }
    paidWeiTotal += wei;
    const weth = Number(wei) / 1e18;
    if (p.wethUsd && Number.isFinite(p.wethUsd)) paidUsd += weth * p.wethUsd;
    payouts.push({
      cycleMonth: p.cycleMonth.slice(0, 7), // 'YYYY-MM'
      chainId: AFFILIATE_PAYOUT_CHAIN_ID,
      chainName: CHAIN_NAME[AFFILIATE_PAYOUT_CHAIN_ID] ?? `Chain ${AFFILIATE_PAYOUT_CHAIN_ID}`,
      txHash: p.txHash,
      explorerUrl: explorerTxUrl(AFFILIATE_PAYOUT_CHAIN_ID, p.txHash),
      amountWeth: round(weth),
    });
  }
  const paidToDateWeth = round(Number(paidWeiTotal) / 1e18);

  const disclaimer =
    `Earnings on Optimism (10) and Unichain (130) are settled and paid by Ophis end to end. ` +
    `Figures on CoW-hosted chains are ${HOSTED_ACCRUAL_LABEL}. ` +
    `Routed volume is cumulative (lifetime); this surface never reports a 30-day figure or a next-payout time.`;

  return {
    appCode,
    generatedAt: now.toISOString(),
    sovereignChains,
    disclaimer,
    routedVolumeUsd: {
      total: round(volSov + volHosted, 4),
      sovereign: round(volSov, 4),
      hosted: round(volHosted, 4),
    },
    ophisFeeAccruedUsd: {
      total: round(ophisSov + ophisHosted),
      sovereign: round(ophisSov),
      hosted: round(ophisHosted),
    },
    ownFeeAccruedUsd: {
      total: round(ownSov + ownHosted),
      sovereignGuaranteed: round(ownSov),
      hostedAccrued: round(ownHosted),
      recipient: input.ownFeeRecipient,
      note:
        `Own-fee is the partner-fee entry you stack to your own recipient in appData, decoded from settled orders on every chain. ` +
        `sovereignGuaranteed (Optimism, Unichain) is settled by Ophis end to end; hostedAccrued is ${HOSTED_ACCRUAL_LABEL}. ` +
        `Only flat Volume own-fees are priced from routed volume; a surplus or price-improvement own-fee is not included.`,
    },
    referral: {
      registered: input.registered,
      paidToDateWeth,
      paidToDateUsd: round(paidUsd),
      payouts,
      note: input.registered
        ? `Referral rebate Ophis pays your wallet monthly in WETH from the Gnosis Safe. paidToDate is exact, summed from executed Safe batches; it is not an estimate and not a current-cycle figure. Paid-to-date and payouts are per referrer wallet (summed across every code that wallet owns).`
        : `This appCode is not a registered referral code, so no Ophis referral rebate accrues. Own-fee (above) is independent of the referral program. Register a code to earn the rebate on top of your own fee.`,
    },
    byChain,
  };
}

// --- DB-backed entry point --------------------------------------------------

/**
 * Fetch and assemble the earnings for one appCode. Restricts to the production
 * mainnet chains (PRODUCTION_CHAIN_IDS) so testnet settlement dust never appears.
 * Keys on trades.appdata_ref_code - the integrator's own identifier (widget
 * top-level appCode or SDK ophisReferrer.code) - which is exactly what an integrator
 * queries with.
 */
export async function getIntegratorEarnings(appCode: string, now: Date): Promise<IntegratorEarnings> {
  const { sql } = await import('./db/index.js');
  const code = appCode.toLowerCase();
  const chainIds = [...PRODUCTION_CHAIN_IDS]; // mutable copy for postgres-js array binding

  // Per-chain: routed volume, trade count, the Ophis fee base (value*bps) and the
  // integrator's own-fee base (value*bps). COALESCE(volume_fee_bps,0) is defensive:
  // an appdata_ref_code is only ever set on a CONFIRMED positive Ophis fee, so these
  // rows already have volume_fee_bps > 0, but a 0/NULL must never over-credit.
  const chainRows = await sql<
    { chain_id: number; volume_usd: string; trades: string; ophis_fee_base: string; own_fee_base: string }[]
  >`
    SELECT
      chain_id,
      COALESCE(SUM(value_usd), 0)::text                                   AS volume_usd,
      COUNT(*)::text                                                      AS trades,
      COALESCE(SUM(value_usd * COALESCE(volume_fee_bps, 0)), 0)::text     AS ophis_fee_base,
      COALESCE(SUM(value_usd * own_fee_bps) FILTER (WHERE own_fee_bps IS NOT NULL), 0)::text AS own_fee_base
    FROM trades
    WHERE appdata_ref_code = ${code}
      AND value_usd IS NOT NULL
      AND chain_id = ANY(${chainIds})
    GROUP BY chain_id
  `;

  // Most recent own-fee recipient for this appCode (the "where it paid out" address).
  const [recip] = await sql<{ recipient: string }[]>`
    SELECT '0x' || encode(own_fee_recipient, 'hex') AS recipient
    FROM trades
    WHERE appdata_ref_code = ${code} AND own_fee_recipient IS NOT NULL
    ORDER BY block_timestamp DESC
    LIMIT 1
  `;

  // Is this appCode a registered referral code? If so, resolve its referrer wallet so
  // we can attach the exact paid-to-date + payout tx links.
  const [rc] = await sql<{ referrer_hex: string }[]>`
    SELECT encode(referrer_wallet, 'hex') AS referrer_hex FROM ref_codes WHERE code = ${code} LIMIT 1
  `;

  let payouts: EarningsPayoutInput[] = [];
  if (rc) {
    const buf = Buffer.from(rc.referrer_hex, 'hex');
    // Only EXECUTED batches with a landed tx and PAID entries - the exact,
    // already-settled referral rebate. Never a pending/proposed cycle (no timing leak).
    const paidRows = await sql<
      { cycle_month: string; tx_hex: string | null; paid_wei: string; weth_usd: string | null }[]
    >`
      SELECT
        b.cycle_month::text                 AS cycle_month,
        encode(b.safe_tx_hash, 'hex')       AS tx_hex,
        e.paid_wei::text                    AS paid_wei,
        b.weth_usd_price::text              AS weth_usd
      FROM affiliate_batch_entries e
      JOIN affiliate_batches b ON b.id = e.batch_id
      WHERE e.referrer_wallet = ${buf}
        AND e.status = 'paid'
        AND b.status = 'executed'
        AND b.safe_tx_hash IS NOT NULL
      ORDER BY b.cycle_month
    `;
    payouts = paidRows
      .filter((r) => r.tx_hex && r.paid_wei)
      .map((r) => ({
        cycleMonth: r.cycle_month,
        txHash: `0x${r.tx_hex}` as `0x${string}`,
        paidWei: r.paid_wei,
        wethUsd: r.weth_usd !== null ? parseFloat(r.weth_usd) : null,
      }));
  }

  const input: EarningsInput = {
    byChain: chainRows.map((r) => ({
      chainId: r.chain_id,
      volumeUsd: parseFloat(r.volume_usd) || 0,
      trades: parseInt(r.trades, 10) || 0,
      ophisFeeBase: parseFloat(r.ophis_fee_base) || 0,
      ownFeeBase: parseFloat(r.own_fee_base) || 0,
    })),
    ownFeeRecipient: recip ? (recip.recipient.toLowerCase() as `0x${string}`) : null,
    registered: !!rc,
    payouts,
  };

  return assembleEarnings(code, input, now);
}
