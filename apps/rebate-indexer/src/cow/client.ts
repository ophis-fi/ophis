import { z } from 'zod';
import { CowTrade, CowOrder, NativePriceResponse, QuoteResponse, AccountOrder } from './types.js';
import { logger } from '../logger.js';

const log = logger.child({ module: 'cow-client' });

// chainId → CoW API path segment on the SHARED hosted orderbook (api.cow.fi).
// Source: https://docs.cow.fi/cow-protocol/reference/apis/orderbook
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

// Optimism (chain 10) is the SOVEREIGN Ophis backend — its own self-hosted CoW
// orderbook at optimism-mainnet.ophis.fi (NOT api.cow.fi). It speaks the identical
// /api/vN/... surface but at the host ROOT (no /{network}/ path segment), so it
// needs its own base URL. Override the host with OP_ORDERBOOK_URL (e.g. the local
// colima backend in dev). Adding it to SUPPORTED_CHAIN_IDS makes the fetcher index
// OP trades exactly like the hosted chains.
export const OPTIMISM_CHAIN_ID = 10;
const OP_ORDERBOOK_BASE = (process.env.OP_ORDERBOOK_URL ?? 'https://optimism-mainnet.ophis.fi').replace(/\/+$/, '');

export const SUPPORTED_CHAIN_IDS = [...Object.keys(COW_API_PATH).map(Number), OPTIMISM_CHAIN_ID];

const BASE_URL = process.env.COW_API_BASE ?? 'https://api.cow.fi';

// Resolve the orderbook URL prefix (everything before `/api/vN/...`) for a chain.
// Hosted chains: `${api.cow.fi}/{network}`. Optimism: the sovereign host root.
export function orderbookBase(chainId: number): string {
  if (chainId === OPTIMISM_CHAIN_ID) return OP_ORDERBOOK_BASE;
  const path = COW_API_PATH[chainId];
  if (!path) throw new Error(`unsupported chain ${chainId}`);
  return `${BASE_URL}/${path}`;
}

// Bound every CoW request so a stalled API can't hang a caller — the batcher
// runs conversion (#360) while holding a Postgres advisory lock, so an
// unbounded request would block the monthly payout. (Codex #474)
const REQUEST_TIMEOUT_MS = 10_000;

async function fetchJson<T>(url: string, schema: z.ZodSchema<T>, init?: RequestInit): Promise<T> {
  // The per-request timeout is COMBINED with any caller signal (the #360 conversion's
  // overall-step abort) so EITHER can cancel the request — the prior `...init` spread
  // let a caller signal silently REPLACE the timeout, unbounding the request. (Codex #474)
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const signal = init?.signal ? AbortSignal.any([timeout, init.signal]) : timeout;
  const res = await fetch(url, { ...init, signal });
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
  const base = orderbookBase(p.chainId);
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
  const url = `${base}/api/v2/trades?${q}`;
  log.debug({ url }, 'GET trades');
  return fetchJson(url, z.array(CowTrade));
}

export async function getOrder(chainId: number, uid: `0x${string}`): Promise<CowOrder> {
  const url = `${orderbookBase(chainId)}/api/v1/orders/${uid}`;
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
  const url = `${orderbookBase(chainId)}/api/v1/token/${token}/native_price`;
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
  readonly signal?: AbortSignal;      // conversion overall-step abort (#474)
}

/**
 * POST /api/v1/quote for a SELL order. Returns CoW's canonical order parameters
 * (incl. appData/appDataHash/feeAmount) which the order POST reuses verbatim, so
 * we never hand-construct the fragile order fields. `signingScheme: presign` tells
 * CoW the order will be made valid on-chain via `setPreSignature` (Safe flow).
 */
export async function getSellQuote(p: SellQuoteParams): Promise<QuoteResponse> {
  const url = `${orderbookBase(p.chainId)}/api/v1/quote`;
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
    signal: p.signal,
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
  readonly signal?: AbortSignal;      // conversion overall-step abort (#474)
}

/**
 * POST /api/v1/orders with `signingScheme: presign` (signature "0x"). The order is
 * created in `presignaturePending` state; an on-chain `setPreSignature(uid, true)`
 * (proposed as a Safe tx, see convert.ts) makes it fillable. Returns the orderUid.
 * Reuses the quote's params; only overrides receiver (Safe), the slippage-floored
 * buyAmount, and a longer validTo.
 */
export async function placePresignOrder(p: PresignOrderParams): Promise<`0x${string}`> {
  const url = `${orderbookBase(p.chainId)}/api/v1/orders`;
  const q = p.quote;
  const body = {
    sellToken: q.sellToken,
    buyToken: q.buyToken,
    receiver: p.receiver,
    // Modern CoW order shape: the FULL sell amount goes in sellAmount and
    // feeAmount is 0 (fees are captured from surplus, not a separate fee field).
    // Reusing the quote's sell/fee split would sign an obsolete order whose uid
    // doesn't match the intended settlement amounts. (Codex #474)
    sellAmount: (BigInt(q.sellAmount) + BigInt(q.feeAmount)).toString(),
    buyAmount: p.buyAmount.toString(),
    validTo: p.validTo,
    appData: q.appData,
    ...(q.appDataHash ? { appDataHash: q.appDataHash } : {}),
    feeAmount: '0',
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
    signal: p.signal,
  });
  return uid as `0x${string}`;
}

/** Open orders for an owner (conversion idempotency — don't re-propose a token that already has a live sell order). */
export async function getOpenOrders(
  chainId: number,
  owner: `0x${string}`,
  signal?: AbortSignal,
): Promise<AccountOrder[]> {
  const url = `${orderbookBase(chainId)}/api/v1/account/${owner}/orders?limit=250&offset=0`;
  log.debug({ url }, 'GET account orders');
  const orders = await fetchJson(url, z.array(AccountOrder), { signal });
  // 'presignaturePending' is the state of a freshly-placed presign order awaiting
  // the on-chain setPreSignature — it MUST count as live, or the conversion
  // idempotency check re-queues the same token every cycle while the Safe tx
  // awaits human signatures. (Codex #474)
  const LIVE = new Set(['open', 'presignaturepending']);
  return orders.filter((o) => LIVE.has((o.status ?? 'open').toLowerCase()));
}
