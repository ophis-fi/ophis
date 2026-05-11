import { z } from 'zod';
import { CowTrade, CowOrder, CowQuoteResponse } from './types.js';
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
  const url = `${BASE_URL}/${path}/api/v1/trades?${q}`;
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

export interface QuoteParams {
  readonly chainId: number;
  readonly sellToken: `0x${string}`;
  readonly buyToken: `0x${string}`;
  readonly sellAmount: bigint;
}

export async function postQuote(p: QuoteParams): Promise<CowQuoteResponse> {
  const path = COW_API_PATH[p.chainId];
  if (!path) throw new Error(`unsupported chain ${p.chainId}`);
  const url = `${BASE_URL}/${path}/api/v1/quote`;
  // CoW expects a richer body; we ask for an indicative sell quote (no validity, no signing).
  const body = {
    sellToken: p.sellToken,
    buyToken: p.buyToken,
    receiver: '0x0000000000000000000000000000000000000000',
    appData: '{}',
    appDataHash: '0x0000000000000000000000000000000000000000000000000000000000000000',
    sellTokenBalance: 'erc20',
    buyTokenBalance: 'erc20',
    from: '0x0000000000000000000000000000000000000000',
    priceQuality: 'fast',
    signingScheme: 'eip712',
    onchainOrder: false,
    kind: 'sell',
    sellAmountBeforeFee: p.sellAmount.toString(),
  };
  log.debug({ url, sellAmount: p.sellAmount.toString() }, 'POST quote');
  return fetchJson(url, CowQuoteResponse, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
