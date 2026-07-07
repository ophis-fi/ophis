import { nativePrice } from './cow/client.js';
import { logger } from './logger.js';
import { alerts } from './telegram/alerter.js';

const log = logger.child({ module: 'pricer' });

// ─── OP native_price is per-atom (since the 2026-07-06 oracle fix) ───────────
// The OP sovereign backend's native_price oracle USED to normalize every token
// to 18 decimals, so a d-decimal token's value came back inflated by 10^(18-d)
// and had to be corrected here. That backend oracle bug was fixed (removed the
// double decimal shift); OP now returns true per-atom prices -- verified live
// that OP USDC ~5.6e8 and WETH 1.0 MATCH Unichain -- so OP prices EXACTLY like
// the hosted chains and NO correction is applied (removing it prevents a
// 10^(sellDec-refDec) over-valuation of every non-6-decimal OP sell).

// Stablecoin canonical pricing targets per chain. The pricer asks CoW for a quote
// from the trade's sellToken to one of these and back-computes USD.
// Addresses sourced from CoW docs and project memory. Audit before extending.
// IMPORTANT: do NOT add a chain with a PLACEHOLDER / cross-chain token address —
// pricing a trade against the wrong chain's stablecoin produces garbage USD that
// pollutes a wallet's rebate volume. assertUsdReferenceSane() (called by runPricer)
// rejects a config where two chains share a token address, the tell-tale of a
// copy-pasted placeholder. A chain with no verified USDC is left OUT entirely: its
// trades then fail to price (value_usd NULL → excluded from the payout matview),
// which under-counts (fail-safe) rather than mis-prices. (plasma/9745 was once
// removed for this reason — it had reused Linea's USDC — and was re-added 2026-06-16
// with the real, decimals-verified USDT0 below: symbol + decimals read on-chain, and
// CoW native_price confirmed serving plasma. Plasma is USDT-native, so its USD
// reference is USDT0 rather than USDC.)
const USD_REFERENCE: Readonly<Record<number, { token: `0x${string}`; decimals: number }>> = {
  1:        { token: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', decimals: 6 },  // USDC mainnet
  100:      { token: '0xddafbb505ad214d7b80b1f830fccc89b60fb7a83', decimals: 6 },  // USDC.e gnosis
  8453:     { token: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', decimals: 6 },  // USDC base
  42161:    { token: '0xaf88d065e77c8cc2239327c5edb3a432268e5831', decimals: 6 },  // USDC arbitrum
  137:      { token: '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359', decimals: 6 },  // USDC polygon
  43114:    { token: '0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e', decimals: 6 },  // USDC avalanche
  56:       { token: '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d', decimals: 18 }, // USDC bnb
  59144:    { token: '0x176211869ca2b568f2a7d4ee941e073a821ee1ff', decimals: 6 },  // USDC linea
  57073:    { token: '0xf1815bd50389c46847f0bda824ec8da914045d14', decimals: 6 },  // USDC ink
  11155111: { token: '0xbe72e441bf55620febc26715db68d3494213d8cb', decimals: 18 }, // USDC sepolia (cow staging)
  10:       { token: '0x0b2c639c533813f4aa9d7837caf62653d097ff85', decimals: 6 },  // USDC optimism (native; np is per-atom since the 2026-07-06 oracle fix)
  9745:     { token: '0xb8ce59fc3717ada4c02eadf9682a9e934f625ebb', decimals: 6 },  // USDT0 plasma (decimals-verified on-chain 2026-06-16; CoW native_price confirmed; USDT-native chain, no liquid USDC; replaces the removed Linea-placeholder)
  130:      { token: '0x078d782b760474a361dda0af3839290b0ef57ad6', decimals: 6 },  // USDC unichain (native Circle USDC; symbol+decimals verified on-chain 2026-06-30). Unichain's sovereign native_price is PER-ATOM (verified: 6-dec USDC ~6.4e8), as is OP's since the 2026-07-06 oracle fix, so NO decimals correction applies on either sovereign chain -- both price like the hosted chains.
};

// Per-trade rebate-volume contribution ceiling (USD). A trade's recorded value is
// clamped to this before it feeds volume_30d_usd / the fixed payout pool, which
// (a) caps how much any single trade — legitimate whale OR a thin/illiquid route
// whose CoW quote an attacker skewed at pricing time — can influence the zero-sum
// pool, and (b) bounds the damage from a broken/wrong-decimals quote. Clamped
// trades are logged + summarised in a Telegram alert so manipulation is visible
// before the (human-signed) monthly batch. Tune via REBATE_MAX_TRADE_USD. (audit P2-2)
const DEFAULT_MAX_TRADE_USD = 1_000_000;

// Resolve + VALIDATE the cap. A misconfigured env must fail fast rather than
// silently disable the mitigation: e.g. `usd > NaN` is always false (no clamping)
// and `0`/negative would clamp every trade to a bad value. Called by runPricer.
export function resolveMaxTradeUsd(): number {
  const raw = process.env.REBATE_MAX_TRADE_USD;
  if (raw === undefined || raw.trim() === '') return DEFAULT_MAX_TRADE_USD;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`REBATE_MAX_TRADE_USD must be a finite positive number; got "${raw}"`);
  }
  return n;
}

// Fail fast if USD_REFERENCE contains a duplicate token address across chains —
// the signature of a copy-pasted placeholder (e.g. the old plasma=Linea entry).
export function assertUsdReferenceSane(): void {
  const seen = new Map<string, number>();
  for (const [chainId, ref] of Object.entries(USD_REFERENCE)) {
    const addr = ref.token.toLowerCase();
    const prev = seen.get(addr);
    if (prev !== undefined) {
      throw new Error(
        `USD_REFERENCE misconfig: chains ${prev} and ${chainId} share token ${addr} ` +
          `(likely a placeholder). Each chain needs its own verified USDC, or be removed.`,
      );
    }
    seen.set(addr, Number(chainId));
  }
}

// Resolve the chain's USD-reference native_price ONCE per run (it's constant), so a
// 1000-row page costs ~1 ref call + 1 sell call per trade, not 2 per trade.
async function getRefNativePrice(
  chainId: number,
  refToken: `0x${string}`,
  cache?: Map<number, number>,
): Promise<number> {
  const cached = cache?.get(chainId);
  if (cached !== undefined) return cached;
  const price = await nativePrice(chainId, refToken);
  cache?.set(chainId, price);
  return price;
}

/**
 * USD value of a trade via CoW's native_price oracle. native_price(token) returns
 * native-token wei per 1 ATOM of the token, so the chain + token decimals CANCEL out
 * of the ratio against the USD reference:
 *
 *   usd = sellAmount_atoms * np(sellToken) / np(USDCref) / 10^USDCdecimals
 *
 * native_price is a float oracle; the result is stored into NUMERIC(20,4) which rounds
 * to 4dp. That precision is ample for this capped, tier-feeding valuation (the value
 * only selects rebate tiers, it is not an exact payout). Selling the USD reference
 * itself short-circuits to exact USD. Any non-finite / zero-ref price throws -> the
 * caller leaves value_usd NULL to retry (same fail-safe as a 404 NoLiquidity).
 */
export async function priceTrade(
  row: {
    tradeUid: `0x${string}`;
    chainId: number;
    sellToken: `0x${string}`;
    sellAmount: bigint;
  },
  refPriceCache?: Map<number, number>,
): Promise<number> {
  const ref = USD_REFERENCE[row.chainId];
  if (!ref) throw new Error(`no USD reference for chain ${row.chainId}`);
  if (row.sellToken.toLowerCase() === ref.token.toLowerCase()) {
    // Selling the chain's USD reference stablecoin itself — already USD. Use the
    // KNOWN ref.decimals (e.g. 6 for USDC.e); native_price carries no decimals field.
    return Number(row.sellAmount) / 10 ** ref.decimals;
  }
  // Every supported chain (OP included, since the 2026-07-06 oracle fix) serves
  // per-atom native_price, so no decimals correction is applied on any side.
  const sellPrice = await nativePrice(row.chainId, row.sellToken);
  const refPrice = await getRefNativePrice(row.chainId, ref.token, refPriceCache);
  // Reject non-finite OR non-positive prices on BOTH sides. A 0/negative native_price
  // is a "couldn't price" signal, not a genuine $0 — fail-safe to value_usd NULL
  // (retried next run) instead of PERMANENTLY recording $0, which would undercount the
  // wallet's volume and mis-tier it. (Codex P2)
  if (!Number.isFinite(sellPrice) || sellPrice <= 0 || !Number.isFinite(refPrice) || refPrice <= 0) {
    throw new Error(`bad native_price (sell=${sellPrice}, ref=${refPrice}) on chain ${row.chainId}`);
  }
  const usd = (Number(row.sellAmount) * sellPrice) / refPrice / 10 ** ref.decimals;
  if (!Number.isFinite(usd)) throw new Error(`non-finite USD for ${row.tradeUid}`);
  return usd;
}

export async function runPricer(): Promise<{ priced: number; failed: number }> {
  // Import real db lazily so this module can be loaded without DATABASE_URL set.
  const { sql } = await import('./db/index.js');

  // Price EVERY unpriced trade, keyset-paginated by the trade_uid primary key.
  // The old single `LIMIT 1000` pass left any backlog (or > 1000 new trades)
  // unpriced, and the `wallets` matview EXCLUDES value_usd-NULL rows — so the
  // scorer/tiers/Safe-payout that run right after would undercount. Keyset
  // paging advances the cursor by PK on EVERY row (priced or failed), so:
  //   - memory stays bounded to one 1000-row page,
  //   - a per-trade failure (left value_usd NULL, retried next run) can't block
  //     the priceable rows behind it, and
  //   - the loop always terminates (cursor strictly increases).
  assertUsdReferenceSane();
  const maxTradeUsd = resolveMaxTradeUsd();
  let priced = 0;
  let failed = 0;
  let clamped = 0;
  const clampedExamples: { tradeUid: `0x${string}`; rawUsd: number }[] = [];
  const refPriceCache = new Map<number, number>(); // chain -> USD-ref native_price, cached per run
  let anyBlocked = false; // set if a pricing error looks like a CoW block (403 / Forbidden / deny-listed)
  let cursor: Buffer = Buffer.alloc(0); // empty bytea sorts before every trade_uid
  for (;;) {
    const rows = await sql<{
      trade_uid: Buffer;
      chain_id: number;
      sell_token: Buffer;
      sell_amount: string;
    }[]>`
      SELECT trade_uid, chain_id, sell_token, sell_amount::text
      FROM trades
      WHERE value_usd IS NULL AND trade_uid > ${cursor}
      ORDER BY trade_uid
      LIMIT 1000
    `;
    if (rows.length === 0) break;

    for (const r of rows) {
      cursor = r.trade_uid; // advance by PK regardless of outcome
      const row = {
        tradeUid: `0x${r.trade_uid.toString('hex')}` as `0x${string}`,
        chainId: r.chain_id,
        sellToken: `0x${r.sell_token.toString('hex')}` as `0x${string}`,
        sellAmount: BigInt(r.sell_amount),
      };
      try {
        let usd = await priceTrade(row, refPriceCache);
        if (usd > maxTradeUsd) {
          log.warn(
            { tradeUid: row.tradeUid, chainId: row.chainId, rawUsd: usd, cap: maxTradeUsd },
            'trade value exceeds per-trade rebate cap; clamping (possible volume inflation or broken quote)',
          );
          if (clampedExamples.length < 10) clampedExamples.push({ tradeUid: row.tradeUid, rawUsd: usd });
          clamped++;
          usd = maxTradeUsd;
        }
        await sql`
          UPDATE trades
          SET value_usd = ${usd}, priced_at = now()
          WHERE trade_uid = ${r.trade_uid}
        `;
        priced++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/\b403\b|forbidden|deny.?list/i.test(msg)) anyBlocked = true;
        log.warn({ err, tradeUid: row.tradeUid }, 'pricing failed');
        failed++;
      }
    }
  }
  if (clamped > 0) {
    log.warn({ clamped, cap: maxTradeUsd, examples: clampedExamples }, 'trades clamped to per-trade rebate cap');
    // Fire-and-forget: surfacing possible volume manipulation must not block the
    // pricer. The message is numbers + trade UIDs only (no attacker-controlled text).
    void alerts
      .alert(
        'pricer',
        `${clamped} trade(s) this run exceeded the $${maxTradeUsd.toLocaleString()} per-trade rebate cap and were clamped. ` +
          `This bounds single-trade pool influence, but may indicate volume inflation via a thin/manipulable route (or a broken quote) — ` +
          `review the affected wallets before the monthly batch is signed.`,
      )
      .catch((e) => log.warn({ err: e }, 'pricer clamp alert failed'));
  }
  // Surface a SYSTEMIC pricing outage (e.g. a CoW API block) — without this, a total
  // pricing failure shows only in logs and silently staleness the volume/tier data
  // (as the 2026-06-05 zero-address /quote deny-list did, undetected until the monitor).
  // Scattered illiquid-token failures alone do NOT trip it: it needs a block-looking
  // error OR failures to dominate the run.
  if (failed > 0 && (anyBlocked || failed >= Math.max(1, priced))) {
    void alerts
      .alert(
        'pricer',
        `Pricer: ${failed} of ${priced + failed} trade(s) failed to price this run` +
          (anyBlocked
            ? ' — the errors look like a CoW API block (403 / Forbidden / deny-listed). Volume + rebate-tier data is STALE until pricing recovers; check the indexer logs.'
            : '. If this persists, volume/tier data goes stale; check the indexer logs.'),
      )
      .catch((e) => log.warn({ err: e }, 'pricer-failure alert failed'));
  }
  log.info({ priced, failed, clamped }, 'pricer complete');
  return { priced, failed };
}
