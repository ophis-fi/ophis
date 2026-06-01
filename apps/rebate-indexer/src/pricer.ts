import { postQuote } from './cow/client.js';
import { logger } from './logger.js';

const log = logger.child({ module: 'pricer' });

// Stablecoin canonical pricing targets per chain. The pricer asks CoW for a quote
// from the trade's sellToken to one of these and back-computes USD.
// Addresses sourced from CoW docs and project memory. Audit before extending.
const USD_REFERENCE: Readonly<Record<number, { token: `0x${string}`; decimals: number }>> = {
  1:        { token: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', decimals: 6 },  // USDC mainnet
  100:      { token: '0xddafbb505ad214d7b80b1f830fccc89b60fb7a83', decimals: 6 },  // USDC.e gnosis
  8453:     { token: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', decimals: 6 },  // USDC base
  42161:    { token: '0xaf88d065e77c8cc2239327c5edb3a432268e5831', decimals: 6 },  // USDC arbitrum
  137:      { token: '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359', decimals: 6 },  // USDC polygon
  43114:    { token: '0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e', decimals: 6 },  // USDC avalanche
  56:       { token: '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d', decimals: 18 }, // USDC bnb
  59144:    { token: '0x176211869ca2b568f2a7d4ee941e073a821ee1ff', decimals: 6 },  // USDC linea
  9745:     { token: '0x176211869ca2b568f2a7d4ee941e073a821ee1ff', decimals: 6 },  // PLACEHOLDER plasma — verify before mainnet pricing
  57073:    { token: '0xf1815bd50389c46847f0bda824ec8da914045d14', decimals: 6 },  // USDC ink
  11155111: { token: '0xbe72e441bf55620febc26715db68d3494213d8cb', decimals: 18 }, // USDC sepolia (cow staging)
};

export interface ComputeTradeUsdParams {
  sellAmount: bigint;
  sellTokenDecimals: number;
  quoteSellAmount: bigint;                                             // the quote's normalized sellAmount in the same token
  quoteBuyAmount: bigint;                                              // → USD-stable token
  quoteBuyTokenDecimals: number;
}

/**
 * USD value of a trade given a CoW /quote response that prices the sellToken into a stablecoin.
 *
 *   usd = (sellAmount / 10^sellDecimals) * (quoteBuyAmount / 10^quoteBuyDecimals)
 *                                       / (quoteSellAmount / 10^sellDecimals)
 *       = sellAmount * quoteBuyAmount / (quoteSellAmount * 10^quoteBuyDecimals)   (× 10^4 / 10^4)
 *
 * Returned as a number rounded to 4 decimal places to match NUMERIC(20,4).
 */
export function computeTradeUsd(p: ComputeTradeUsdParams): number {
  if (p.sellAmount === 0n) return 0;
  if (p.quoteSellAmount === 0n) throw new Error('computeTradeUsd: quoteSellAmount must be non-zero');
  // Compute in fixed-point: scale numerator by 10^4 to preserve 4dp precision,
  // then round to nearest (round-half-up) to match NUMERIC(20,4) DB column semantics.
  const divisor = p.quoteSellAmount * (10n ** BigInt(p.quoteBuyTokenDecimals));
  const scaledFloor = (p.sellAmount * p.quoteBuyAmount * 10_000n) / divisor;
  // Check remainder to decide whether to round up.
  const remainder = (p.sellAmount * p.quoteBuyAmount * 10_000n) % divisor;
  const scaled = remainder * 2n >= divisor ? scaledFloor + 1n : scaledFloor;
  return Number(scaled) / 10_000;
}

export async function priceTrade(row: {
  tradeUid: `0x${string}`;
  chainId: number;
  sellToken: `0x${string}`;
  sellAmount: bigint;
}): Promise<number> {
  const ref = USD_REFERENCE[row.chainId];
  if (!ref) throw new Error(`no USD reference for chain ${row.chainId}`);
  if (row.sellToken.toLowerCase() === ref.token.toLowerCase()) {
    // Selling the chain's USD reference stablecoin itself — already USD.
    // Use ref.decimals (the KNOWN decimals of that stablecoin, e.g. 6 for
    // USDC/USDC.e). Do NOT use fetchTokenDecimals here: CoW's native_price
    // endpoint returns no `decimals` field, so that helper always falls back to
    // 18 — which would understate a USDC sell by 10^12 and corrupt the payout.
    return Number(row.sellAmount) / 10 ** ref.decimals;
  }
  const quote = await postQuote({
    chainId: row.chainId,
    sellToken: row.sellToken,
    buyToken: ref.token,
    sellAmount: row.sellAmount,
  });
  return computeTradeUsd({
    sellAmount: row.sellAmount,
    // sellTokenDecimals cancels out of computeTradeUsd's ratio (it appears in
    // both the trade and quote sell amounts), so the value here is irrelevant.
    sellTokenDecimals: 18,
    quoteSellAmount: BigInt(quote.quote.sellAmount),
    quoteBuyAmount: BigInt(quote.quote.buyAmount),
    quoteBuyTokenDecimals: ref.decimals,
  });
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
  let priced = 0;
  let failed = 0;
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
        const usd = await priceTrade(row);
        await sql`
          UPDATE trades
          SET value_usd = ${usd}, priced_at = now()
          WHERE trade_uid = ${r.trade_uid}
        `;
        priced++;
      } catch (err) {
        log.warn({ err, tradeUid: row.tradeUid }, 'pricing failed');
        failed++;
      }
    }
  }
  log.info({ priced, failed }, 'pricer complete');
  return { priced, failed };
}
