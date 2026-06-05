import { z } from 'zod';
import { CowTrade, CowOrder, NativePriceResponse } from './types.js';
import { logger } from '../logger.js';

const log = logger.child({ module: 'cow-client' });

// chainId → CoW API path segment. Source: https://docs.cow.fi/cow-protocol/reference/apis/orderbook
const COW_API_PATH: Readonly<Record<number, string>> = {
  1:        'mainnet',
  100:      'xdai',
  8453:     'base',
  42161:    'arbitrum_one',
  137:      'polygon',
  43114:    'avalanche',
  56:       'bnb',
  59144:    'linea',
  9745:     'plasma',
  57073:    'ink',
  11155111: 'sepolia',
};

export const SUPPORTED_CHAIN_IDS = Object.keys(COW_API_PATH).map(Number);

const BASE_URL = process.env.COW_API_BASE ?? 'https://api.cow.fi';

async function fetchJson<T>(url: string, schema: z.ZodSchema<T>, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const body = await res.text().catch(() => '<unreadable>');
    throw new Error(`CoW API ${res.status} ${res.statusText} @ ${url} — ${body.slice(0, 200)}`);
  }
  const json: unknown = await res.json();
  return schema.parse(json);
}

export interface ListTradesParams {
  readonly chainId: number;
  readonly owner?: `0x${string}`;
  readonly offset?: number;
  readonly limit?: number;                                            // CoW max is 1000
}

export async function listTrades(p: ListTradesParams): Promise<CowTrade[]> {
  const path = COW_API_PATH[p.chainId];
  if (!path) throw new Error(`unsupported chain ${p.chainId}`);
  const q = new URLSearchParams();
  if (p.owner) q.set('owner', p.owner);
  q.set('offset', String(p.offset ?? 0));
  q.set('limit', String(p.limit ?? 1000));
  // v2 (paginated). v1 is deprecated AND unpaginated — it ignores offset/limit
  // and returns the owner's ENTIRE trade set on every call, so the caller's
  // "stop when page < limit" loop never terminates for owners with >= limit
  // trades (the fetcher would spin forever holding its advisory lock). v2 honors
  // offset/limit; the loop's "offset += returned; stop when < limit" matches its
  // documented pagination protocol exactly.
  const url = `${BASE_URL}/${path}/api/v2/trades?${q}`;
  log.debug({ url }, 'GET trades');
  return fetchJson(url, z.array(CowTrade));
}

export async function getOrder(chainId: number, uid: `0x${string}`): Promise<CowOrder> {
  const path = COW_API_PATH[chainId];
  if (!path) throw new Error(`unsupported chain ${chainId}`);
  const url = `${BASE_URL}/${path}/api/v1/orders/${uid}`;
  log.debug({ url }, 'GET order');
  return fetchJson(url, CowOrder);
}

/**
 * CoW's price ORACLE: the token's price as native-token wei per 1 ATOM of `token`.
 * A signer-less GET — NO from/receiver/body — so it structurally cannot hit the
 * zero-address deny-list that broke the old /quote-based pricer (2026-06-05). For a
 * thin/unrouteable token CoW returns 404 `NoLiquidity`; fetchJson then throws and the
 * caller leaves value_usd NULL to retry next run (the same fail-safe as before).
 */
export async function nativePrice(chainId: number, token: `0x${string}`): Promise<number> {
  const path = COW_API_PATH[chainId];
  if (!path) throw new Error(`unsupported chain ${chainId}`);
  const url = `${BASE_URL}/${path}/api/v1/token/${token}/native_price`;
  log.debug({ url }, 'GET native_price');
  return (await fetchJson(url, NativePriceResponse)).price;
}
