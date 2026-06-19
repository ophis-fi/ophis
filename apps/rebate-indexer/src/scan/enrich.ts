// src/scan/enrich.ts
import { priceTrade } from '../pricer.js';
import type { Swap } from './types.js';

// Static fast-path for the common tokens so a quiet run needs zero token RPC.
// Keyed by lowercased address. Covers WETH/USDC/USDT/DAI/WBTC on the scanned chains.
const STATIC: Record<string, { symbol: string; decimals: number }> = {
  '0x4200000000000000000000000000000000000006': { symbol: 'WETH', decimals: 18 }, // OP WETH
  '0x94b008aa00579c1307b0ef2c499ad98a8ce58e58': { symbol: 'USDT', decimals: 6 },  // OP USDT
  '0x0b2c639c533813f4aa9d7837caf62653d097ff85': { symbol: 'USDC', decimals: 6 },  // OP USDC
  '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': { symbol: 'WETH', decimals: 18 }, // ETH WETH
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': { symbol: 'USDC', decimals: 6 },  // ETH USDC
  '0xdac17f958d2ee523a2206206994597c13d831ec7': { symbol: 'USDT', decimals: 6 },  // ETH USDT
  '0x6b175474e89094c44da98b954eedeac495271d0f': { symbol: 'DAI', decimals: 18 },  // ETH DAI
  '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599': { symbol: 'WBTC', decimals: 8 },  // ETH WBTC
};

const ERC20_ABI = [
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
] as const;

export interface Erc20Reader {
  readContract(a: { address: `0x${string}`; abi: unknown; functionName: 'symbol' | 'decimals' }): Promise<unknown>;
}

export async function tokenMeta(
  addr: `0x${string}`,
  reader: Erc20Reader | null,
  cache: Map<string, { symbol: string | null; decimals: number | null }>,
): Promise<{ symbol: string | null; decimals: number | null }> {
  const key = addr.toLowerCase();
  const stat = STATIC[key];
  if (stat) return stat;
  const cached = cache.get(key);
  if (cached) return cached;
  if (!reader) {
    const r = { symbol: null, decimals: null };
    cache.set(key, r);
    return r;
  }
  let result: { symbol: string | null; decimals: number | null };
  try {
    const [symbol, decimals] = await Promise.all([
      reader.readContract({ address: addr, abi: ERC20_ABI, functionName: 'symbol' }),
      reader.readContract({ address: addr, abi: ERC20_ABI, functionName: 'decimals' }),
    ]);
    result = { symbol: String(symbol), decimals: Number(decimals) };
  } catch {
    result = { symbol: null, decimals: null };
  }
  cache.set(key, result);
  return result;
}

export interface EnrichDeps {
  reader: Erc20Reader | null;
  metaCache: Map<string, { symbol: string | null; decimals: number | null }>;
  priceFn?: typeof priceTrade;
  refPriceCache?: Map<number, number>;
}

export async function enrichSwap(swap: Swap, deps: EnrichDeps): Promise<Swap> {
  const price = deps.priceFn ?? priceTrade;
  const [sellMeta, buyMeta] = await Promise.all([
    tokenMeta(swap.sell.token, deps.reader, deps.metaCache),
    tokenMeta(swap.buy.token, deps.reader, deps.metaCache),
  ]);
  let notionalUsd: number | null = null;
  try {
    notionalUsd = await price(
      { tradeUid: swap.orderUid, chainId: swap.chainId, sellToken: swap.sell.token, sellAmount: BigInt(swap.sell.amount) },
      deps.refPriceCache,
    );
  } catch {
    notionalUsd = null; // thin/unrouteable token, same fail-safe the indexer uses
  }
  return {
    ...swap,
    sell: { ...swap.sell, ...sellMeta },
    buy: { ...swap.buy, ...buyMeta },
    notionalUsd,
  };
}
