/**
 * Orderbook upstream client for the compat Worker.
 *
 * NOTE on api-dx `POST /api/v1/quote/draft` (quote + ready-to-sign draft +
 * EIP-712 envelope in one call): that endpoint is in flight in a parallel PR
 * and is not on main yet, so this module composes the same result from the
 * LIVE endpoints: `POST /api/v1/quote` plus the @ophis/sdk order-build core
 * (WP0). The composition is not a stopgap only: the compat surface needs
 * compat-specific appData (the `odos<code>` referral mapping, the `compat`
 * source tag), which the generic draft endpoint's default appData does not
 * carry, so local building via `buildOphisFullAppData`/`buildOrder` stays
 * correct regardless of merge order. If quote/draft later grows appData
 * passthrough, `fetchOrderbookQuote` is the single seam to swap.
 */
import {
  getOphisOrderbookUrl,
  parseOphisApiError,
  OphisRateLimitError,
  OphisUnroutableError,
  OphisApiError,
  type Address,
} from '@ophis/sdk';

import { CompatError } from './types.js';

const TIMEOUT_MS = 10_000;

async function timedFetch(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  label: string,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } catch (err) {
    throw new CompatError('UPSTREAM_UNAVAILABLE', `${label}: orderbook unreachable (${(err as Error)?.message ?? 'fetch failed'}).`, {
      retryAfterSeconds: 1,
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Maps a failed orderbook response to the compat error taxonomy via the SDK's
 * typed parser: unroutable stays an answer (404 NO_ROUTE), upstream 429/5xx
 * become retryable 503s (the api-dx doctrine), 4xx validation passes the
 * upstream description through.
 */
async function throwUpstream(res: Response, label: string): Promise<never> {
  const body: unknown = await res.json().catch(() => undefined);
  const parsed = parseOphisApiError({ status: res.status, body, headers: res.headers });
  const upstream = {
    errorType: parsed.errorType,
    traceId: parsed.traceId,
    description: parsed.message,
  };
  if (parsed instanceof OphisUnroutableError) {
    throw new CompatError('NO_ROUTE', `No route for this pair/amount right now. This is an answer, not a transient failure; retrying the same request cannot change it.`, { upstream });
  }
  if (parsed instanceof OphisRateLimitError || res.status >= 500) {
    const code = parsed instanceof OphisRateLimitError ? 'UPSTREAM_RATE_LIMITED' : 'UPSTREAM_UNAVAILABLE';
    throw new CompatError(code, `${label}: orderbook temporarily unavailable (upstream ${res.status}).`, {
      upstream,
      retryAfterSeconds: (parsed as OphisApiError).retryAfterSeconds ?? 1,
    });
  }
  throw new CompatError('UPSTREAM_VALIDATION', `${label}: orderbook rejected the request (${parsed.message}).`, { upstream });
}

export interface OrderbookQuote {
  sellAmount: string;
  buyAmount: string;
  feeAmount: string;
  validTo: number;
  gasAmount: string | null;
  gasPriceWei: string | null;
  quoteId: number | null;
  /** ISO 8601 quote expiration from the orderbook. */
  expiration: string | null;
}

const asAtoms = (v: unknown): string | null =>
  typeof v === 'string' && /^[0-9]+$/.test(v) ? v : null;

export interface FetchQuoteParams {
  chainId: number;
  sellToken: Address;
  buyToken: Address;
  /** exact-in atoms (sellAmountBeforeFee) */
  sellAmount: string;
  from: Address;
  priceQuality: 'fast' | 'optimal';
  fullAppData: string;
  appDataHash: string;
  validForSeconds: number;
}

/** `POST /api/v1/quote` with the exact appData the draft will sign, so the quoted amounts already price the partner fee. */
export async function fetchOrderbookQuote(
  p: FetchQuoteParams,
  fetchImpl: typeof fetch,
): Promise<OrderbookQuote> {
  const body = {
    sellToken: p.sellToken,
    buyToken: p.buyToken,
    from: p.from,
    receiver: p.from,
    kind: 'sell',
    sellAmountBeforeFee: p.sellAmount,
    partiallyFillable: false,
    sellTokenBalance: 'erc20',
    buyTokenBalance: 'erc20',
    priceQuality: p.priceQuality,
    signingScheme: 'eip712',
    onchainOrder: false,
    appData: p.fullAppData,
    appDataHash: p.appDataHash,
    validFor: p.validForSeconds,
  };
  const url = `${getOphisOrderbookUrl(p.chainId)}/api/v1/quote`;
  const res = await timedFetch(
    fetchImpl,
    url,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
    'quote',
  );
  if (!res.ok) await throwUpstream(res, 'quote');
  const json = (await res.json()) as {
    quote?: {
      sellAmount?: unknown;
      buyAmount?: unknown;
      feeAmount?: unknown;
      validTo?: unknown;
      gasAmount?: unknown;
      gasPrice?: unknown;
    };
    id?: unknown;
    expiration?: unknown;
  };
  const q = json.quote;
  const sellAmount = asAtoms(q?.sellAmount);
  const buyAmount = asAtoms(q?.buyAmount);
  const feeAmount = asAtoms(q?.feeAmount);
  if (!q || !sellAmount || !buyAmount || !feeAmount || typeof q.validTo !== 'number') {
    throw new CompatError('UPSTREAM_UNAVAILABLE', 'quote: orderbook returned an unexpected shape.', {
      retryAfterSeconds: 1,
    });
  }
  return {
    sellAmount,
    buyAmount,
    feeAmount,
    validTo: q.validTo,
    gasAmount: asAtoms(q.gasAmount),
    gasPriceWei: asAtoms(q.gasPrice),
    quoteId: typeof json.id === 'number' ? json.id : null,
    expiration: typeof json.expiration === 'string' ? json.expiration : null,
  };
}

export interface OrderCreationBody {
  sellToken: Address;
  buyToken: Address;
  receiver: Address;
  sellAmount: string;
  buyAmount: string;
  validTo: number;
  feeAmount: string;
  kind: 'sell' | 'buy';
  partiallyFillable: boolean;
  sellTokenBalance: 'erc20';
  buyTokenBalance: 'erc20';
  appData: string;
  appDataHash: string;
  signingScheme: 'eip712' | 'ethsign';
  signature: string;
  from: Address;
  quoteId?: number;
}

/** `POST /api/v1/orders`: relays a pre-signed OrderCreation; returns the order UID. */
export async function relayOrder(
  chainId: number,
  body: OrderCreationBody,
  fetchImpl: typeof fetch,
): Promise<string> {
  const url = `${getOphisOrderbookUrl(chainId)}/api/v1/orders`;
  const res = await timedFetch(
    fetchImpl,
    url,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
    'submit',
  );
  if (!res.ok) await throwUpstream(res, 'submit');
  const uid = (await res.json()) as unknown;
  if (typeof uid !== 'string' || !/^0x[0-9a-fA-F]{112}$/.test(uid)) {
    throw new CompatError('UPSTREAM_UNAVAILABLE', 'submit: orderbook returned an unexpected shape.', {
      retryAfterSeconds: 1,
    });
  }
  return uid;
}

/** `GET /api/v1/orders/{uid}`: raw order (status, executed amounts, ...). */
export async function fetchOrder(
  chainId: number,
  orderUid: string,
  fetchImpl: typeof fetch,
): Promise<Record<string, unknown>> {
  const url = `${getOphisOrderbookUrl(chainId)}/api/v1/orders/${orderUid}`;
  const res = await timedFetch(fetchImpl, url, { method: 'GET' }, 'order-status');
  if (res.status === 404) {
    throw new CompatError('NOT_FOUND', `Order ${orderUid} not found on chain ${chainId}.`);
  }
  if (!res.ok) await throwUpstream(res, 'order-status');
  return (await res.json()) as Record<string, unknown>;
}

/** `GET /api/v1/trades?orderUid=`: settlement trades for the order (empty until settled). */
export async function fetchTrades(
  chainId: number,
  orderUid: string,
  fetchImpl: typeof fetch,
): Promise<unknown[]> {
  const url = `${getOphisOrderbookUrl(chainId)}/api/v1/trades?orderUid=${orderUid}`;
  const res = await timedFetch(fetchImpl, url, { method: 'GET' }, 'order-status');
  if (!res.ok) return [];
  const body = (await res.json()) as unknown;
  return Array.isArray(body) ? body : [];
}
