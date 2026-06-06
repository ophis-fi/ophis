import { z } from 'zod';
import { CowTrade, CowOrder, NativePriceResponse, QuoteResponse, AccountOrder } from './types.js';
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

// ---------------------------------------------------------------------------
// #360 fee conversion: quote + place a pre-signed sell order (token -> WETH).
// ---------------------------------------------------------------------------

export interface SellQuoteParams {
  readonly chainId: number;
  readonly sellToken: `0x${string}`;
  readonly buyToken: `0x${string}`;
  readonly sellAmountBeforeFee: bigint;
  readonly from: `0x${string}`;       // the fee Safe (quote `from`)
  readonly receiver: `0x${string}`;   // the fee Safe (WETH returns here)
}

/**
 * POST /api/v1/quote for a SELL order. Returns CoW's canonical order parameters
 * (incl. appData/appDataHash/feeAmount) which the order POST reuses verbatim, so
 * we never hand-construct the fragile order fields. `signingScheme: presign` tells
 * CoW the order will be made valid on-chain via `setPreSignature` (Safe flow).
 */
export async function getSellQuote(p: SellQuoteParams): Promise<QuoteResponse> {
  const path = COW_API_PATH[p.chainId];
  if (!path) throw new Error(`unsupported chain ${p.chainId}`);
  const url = `${BASE_URL}/${path}/api/v1/quote`;
  const body = {
    sellToken: p.sellToken,
    buyToken: p.buyToken,
    from: p.from,
    receiver: p.receiver,
    kind: 'sell',
    sellAmountBeforeFee: p.sellAmountBeforeFee.toString(),
    signingScheme: 'presign',
    priceQuality: 'optimal',
  };
  log.debug({ url, sellToken: p.sellToken }, 'POST quote');
  return fetchJson(url, QuoteResponse, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const OrderUid = z.string().regex(/^0x[0-9a-f]{112}$/i);

export interface PresignOrderParams {
  readonly chainId: number;
  readonly quote: QuoteResponse['quote'];
  readonly buyAmount: bigint;         // slippage-floored minimum buy (<= quote.buyAmount)
  readonly receiver: `0x${string}`;   // the fee Safe
  readonly validTo: number;           // unix seconds; long enough for human Safe signing + fill
  readonly from: `0x${string}`;       // the fee Safe
}

/**
 * POST /api/v1/orders with `signingScheme: presign` (signature "0x"). The order is
 * created in `presignaturePending` state; an on-chain `setPreSignature(uid, true)`
 * (proposed as a Safe tx, see convert.ts) makes it fillable. Returns the orderUid.
 * Reuses the quote's params; only overrides receiver (Safe), the slippage-floored
 * buyAmount, and a longer validTo.
 */
export async function placePresignOrder(p: PresignOrderParams): Promise<`0x${string}`> {
  const path = COW_API_PATH[p.chainId];
  if (!path) throw new Error(`unsupported chain ${p.chainId}`);
  const url = `${BASE_URL}/${path}/api/v1/orders`;
  const q = p.quote;
  const body = {
    sellToken: q.sellToken,
    buyToken: q.buyToken,
    receiver: p.receiver,
    sellAmount: q.sellAmount,
    buyAmount: p.buyAmount.toString(),
    validTo: p.validTo,
    appData: q.appData,
    ...(q.appDataHash ? { appDataHash: q.appDataHash } : {}),
    feeAmount: q.feeAmount,
    kind: 'sell',
    partiallyFillable: false,
    sellTokenBalance: q.sellTokenBalance ?? 'erc20',
    buyTokenBalance: q.buyTokenBalance ?? 'erc20',
    signingScheme: 'presign',
    signature: '0x',
    from: p.from,
  };
  log.info({ url, sellToken: q.sellToken, buyAmount: body.buyAmount }, 'POST presign order');
  // OrderUid validates the 56-byte hex shape, so the cast to the template-literal
  // type is sound (zod infers a plain `string`).
  const uid = await fetchJson(url, OrderUid, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return uid as `0x${string}`;
}

/** Open orders for an owner (conversion idempotency — don't re-propose a token that already has a live sell order). */
export async function getOpenOrders(chainId: number, owner: `0x${string}`): Promise<AccountOrder[]> {
  const path = COW_API_PATH[chainId];
  if (!path) throw new Error(`unsupported chain ${chainId}`);
  const url = `${BASE_URL}/${path}/api/v1/account/${owner}/orders?limit=250&offset=0`;
  log.debug({ url }, 'GET account orders');
  const orders = await fetchJson(url, z.array(AccountOrder));
  return orders.filter((o) => (o.status ?? 'open') === 'open');
}
