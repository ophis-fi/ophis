/**
 * Native-denominated valuation (owner decision 7).
 *
 * The original v3 surface reports USD floats for inValues/outValues and
 * netOutValue. Ophis has no USD feed wired yet, so this module denominates
 * every value in the chain's NATIVE token (`ophis.valueCurrency: 'native'`),
 * using the orderbook's own native-price endpoint
 * (`GET /api/v1/token/{address}/native_price`, price = native atoms per token
 * atom): value = atoms * price / 1e18, i.e. whole native units. percentDiff is
 * pinned to 0 and priceImpact to null (no independent mid-price source; a
 * fabricated number would be worse than a declared absence). When a USD feed
 * is chosen, this module is the only place that changes.
 */
import { getOphisOrderbookUrl } from '@ophis/sdk';

import { warning, type CompatWarning } from './types.js';

/** Price cache TTL (ms). Prices feed display values only, never signed amounts. */
const PRICE_TTL_MS = 60_000;

const priceCache = new Map<string, { price: number; at: number }>();

/** Test hook: drop all cached prices. */
export const clearPriceCache = (): void => {
  priceCache.clear();
};

const NATIVE_PRICE_TIMEOUT_MS = 5_000;

async function nativePrice(
  chainId: number,
  token: string,
  fetchImpl: typeof fetch,
  nowMs: number,
): Promise<number | null> {
  const key = `${chainId}:${token.toLowerCase()}`;
  const cached = priceCache.get(key);
  if (cached && nowMs - cached.at < PRICE_TTL_MS) return cached.price;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), NATIVE_PRICE_TIMEOUT_MS);
    const res = await fetchImpl(
      `${getOphisOrderbookUrl(chainId)}/api/v1/token/${token}/native_price`,
      { signal: controller.signal },
    );
    clearTimeout(timer);
    if (!res.ok) return null;
    const body = (await res.json()) as { price?: unknown };
    if (typeof body.price !== 'number' || !Number.isFinite(body.price)) return null;
    priceCache.set(key, { price: body.price, at: nowMs });
    return body.price;
  } catch {
    return null;
  }
}

/** atoms * (native atoms per token atom) / 1e18 = whole native units. Float precision is fine for display values. */
const toNativeValue = (atoms: string, price: number): number => (Number(atoms) * price) / 1e18;

export interface CompatValues {
  inValues: number[];
  outValues: number[];
  netOutValue: number;
  warnings: CompatWarning[];
}

/**
 * Values for one in/out pair. Best-effort: a failed price read yields zeros
 * plus a VALUES_UNAVAILABLE warning instead of failing the quote (values are
 * informational; the signed amounts are exact atoms and never touch this path).
 */
export async function computeValues(
  args: {
    chainId: number;
    sellToken: string;
    buyToken: string;
    /** total sell atoms (before-fee) */
    inAmount: string;
    /** quoted buy atoms */
    outAmount: string;
  },
  fetchImpl: typeof fetch,
  nowMs: number,
): Promise<CompatValues> {
  const [sellPrice, buyPrice] = await Promise.all([
    nativePrice(args.chainId, args.sellToken, fetchImpl, nowMs),
    nativePrice(args.chainId, args.buyToken, fetchImpl, nowMs),
  ]);
  const warnings: CompatWarning[] = [];
  if (sellPrice === null || buyPrice === null) {
    warnings.push(
      warning(
        'VALUES_UNAVAILABLE',
        'Native price lookup failed for one or both tokens; inValues/outValues/netOutValue are 0. Amounts in atoms are exact and unaffected.',
      ),
    );
    return { inValues: [0], outValues: [0], netOutValue: 0, warnings };
  }
  const inValue = toNativeValue(args.inAmount, sellPrice);
  const outValue = toNativeValue(args.outAmount, buyPrice);
  // netOutValue = outValue - user-paid gas value; user-paid gas on Ophis is 0
  // (solver-submitted settlement), so the identity holds with gasEstimateValue = 0.
  return { inValues: [inValue], outValues: [outValue], netOutValue: outValue, warnings };
}
