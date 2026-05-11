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

const TOKEN_DECIMALS_CACHE = new Map<string, number>();

async function fetchTokenDecimals(chainId: number, token: `0x${string}`): Promise<number> {
  const key = `${chainId}:${token.toLowerCase()}`;
  const cached = TOKEN_DECIMALS_CACHE.get(key);
  if (cached !== undefined) return cached;
  // We avoid a viem chain client here and rely on the CoW /tokens endpoint when available,
  // falling back to 18. Long-tail tokens that aren't in CoW's registry rarely make trades
  // through CoW in the first place.
  // TODO(post-launch): replace with a per-chain viem client + ERC20.decimals() call.
  const path = chainPath(chainId);
  try {
    const res = await fetch(`${process.env.COW_API_BASE ?? 'https://api.cow.fi'}/${path}/api/v1/tokens/${token}/native_price`);
    if (res.ok) {
      const json: any = await res.json();
      if (typeof json?.decimals === 'number') {
        TOKEN_DECIMALS_CACHE.set(key, json.decimals);
        return json.decimals;
      }
    }
  } catch { /* fall through */ }
  TOKEN_DECIMALS_CACHE.set(key, 18);
  return 18;
}

function chainPath(chainId: number): string {
  const m: Record<number, string> = {
    1: 'mainnet', 100: 'xdai', 8453: 'base', 42161: 'arbitrum_one', 137: 'polygon',
    43114: 'avalanche', 56: 'bnb', 59144: 'linea', 9745: 'plasma', 57073: 'ink', 11155111: 'sepolia',
  };
  const p = m[chainId];
  if (!p) throw new Error(`unsupported chain ${chainId}`);
  return p;
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
    const decimals = await fetchTokenDecimals(row.chainId, row.sellToken);
    return Number(row.sellAmount) / 10 ** decimals;                    // already USD-denominated
  }
  const sellDecimals = await fetchTokenDecimals(row.chainId, row.sellToken);
  const quote = await postQuote({
    chainId: row.chainId,
    sellToken: row.sellToken,
    buyToken: ref.token,
    sellAmount: row.sellAmount,
  });
  return computeTradeUsd({
    sellAmount: row.sellAmount,
    sellTokenDecimals: sellDecimals,
    quoteSellAmount: BigInt(quote.quote.sellAmount),
    quoteBuyAmount: BigInt(quote.quote.buyAmount),
    quoteBuyTokenDecimals: ref.decimals,
  });
}

export async function runPricer(): Promise<{ priced: number; failed: number }> {
  // Import real db lazily so this module can be loaded without DATABASE_URL set.
  const { sql, db, schema } = await import('./db/index.js');
  const unpriced = await db
    .select({
      tradeUid: schema.trades.tradeUid,
      chainId: schema.trades.chainId,
      sellToken: schema.trades.sellToken,
      sellAmount: schema.trades.sellAmount,
    })
    .from(schema.trades)
    .where(sql`value_usd IS NULL`)
    .limit(1_000);

  let priced = 0;
  let failed = 0;
  for (const row of unpriced) {
    try {
      const usd = await priceTrade(row);
      await db.execute(sql`
        UPDATE trades
        SET value_usd = ${usd}, priced_at = now()
        WHERE trade_uid = ${row.tradeUid}
      `);
      priced++;
    } catch (err) {
      log.warn({ err, tradeUid: row.tradeUid }, 'pricing failed');
      failed++;
    }
  }
  log.info({ priced, failed, remaining: unpriced.length - priced - failed }, 'pricer pass complete');
  return { priced, failed };
}
