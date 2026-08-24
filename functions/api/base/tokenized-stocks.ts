/**
 * GET /api/base/tokenized-stocks
 *
 * Same-origin, edge-cached snapshot of Coinbase's tokenized stocks on Base
 * (B20 native precompiles: no bytecode, but the ERC-20 views and the B20
 * asset extensions answer normally). The swap UI's Base asset panel reads it
 * to show the corporate-action multiplier, transfer pauses, and whether a
 * listed stock has been issued yet.
 *
 * The address set is the shipped token list under /token-lists/ so the
 * selector and this endpoint can never drift; every entry is re-validated
 * here before it reaches an RPC. Reads fail closed: a malformed list, an RPC
 * error, or an undecodable word yields a 502, never a half-populated payload.
 *
 * Reference: https://docs.base.org/base-chain/asset-issuance/tokenized-stocks-on-base
 */

const CHAIN_ID = 8453;
const LIST_PATH = '/token-lists/coinbase-tokenized-stocks.json';
const BASE_RPCS = [
  'https://base-rpc.publicnode.com',
  'https://mainnet.base.org',
  'https://base.drpc.org',
];
const CACHE_CONTROL = 'public, max-age=60, s-maxage=300, stale-while-revalidate=3600';
const RPC_TIMEOUT_MS = 4_000;
const MAX_LIST_BYTES = 200_000;
const MAX_TOKENS = 64;
const MAX_TEXT_LENGTH = 100;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
// Mirrors the frontend list validator (no angle brackets) plus a control-char ban.
const TEXT_RE = /^[^<>\u0000-\u001F\u007F]+$/;
const WORD_RE = /^0x[0-9a-fA-F]{64}$/;
const WAD = 10n ** 18n;

// IB20Asset.multiplier(), IB20.pausedFeatures(), IERC20.totalSupply()
const SELECTORS = ['0x1b3ed722', '0xde9997e3', '0x18160ddd'] as const;
const CALLS_PER_TOKEN = SELECTORS.length;
const PAUSABLE_FEATURE_TRANSFER = 0n;

export interface StockListEntry {
  address: string;
  symbol: string;
  name: string;
}

export interface StockAsset extends StockListEntry {
  /** Current corporate-action multiplier as an 18-decimal string, e.g. "1.020000000000000000". */
  multiplier: string;
  /** false while totalSupply is 0: listed by the issuer but not minted yet. */
  issued: boolean;
  /** true when the TRANSFER pausable feature is active on the token. */
  transfersPaused: boolean;
}

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: 'eth_call';
  params: [{ to: string; data: string }, 'latest'];
}

interface JsonRpcResponse {
  id?: unknown;
  result?: unknown;
  error?: unknown;
}

interface Env {
  ASSETS: Fetcher;
}

function text(value: unknown, field: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_TEXT_LENGTH ||
    !TEXT_RE.test(value)
  ) {
    throw new Error(`Stock list entry has an invalid ${field}`);
  }
  return value;
}

export function parseStockList(raw: unknown): StockListEntry[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new Error('Stock list is malformed');
  const tokens = (raw as { tokens?: unknown }).tokens;
  if (!Array.isArray(tokens)) throw new Error('Stock list is malformed');
  if (tokens.length === 0) throw new Error('Stock list is empty');
  if (tokens.length > MAX_TOKENS) throw new Error('Stock list is too large');

  const seen = new Set<string>();
  return tokens.map((item): StockListEntry => {
    if (!item || typeof item !== 'object' || Array.isArray(item))
      throw new Error('Stock list entry is malformed');
    const entry = item as Record<string, unknown>;
    if (entry.chainId !== CHAIN_ID) throw new Error(`Stock list entry is not on chain ${CHAIN_ID}`);
    if (typeof entry.address !== 'string' || !ADDRESS_RE.test(entry.address)) {
      throw new Error('Stock list entry has an invalid address');
    }
    const key = entry.address.toLowerCase();
    if (seen.has(key)) throw new Error('Stock list has a duplicate address');
    seen.add(key);
    return {
      address: entry.address,
      symbol: text(entry.symbol, 'symbol'),
      name: text(entry.name, 'name'),
    };
  });
}

export function buildAssetBatch(entries: readonly StockListEntry[]): JsonRpcRequest[] {
  return entries.flatMap((entry, index) =>
    SELECTORS.map(
      (data, offset): JsonRpcRequest => ({
        jsonrpc: '2.0',
        id: index * CALLS_PER_TOKEN + offset + 1,
        method: 'eth_call',
        params: [{ to: entry.address, data }, 'latest'],
      }),
    ),
  );
}

export function rpcResultsById(raw: unknown, expectedIds: readonly number[]): Map<number, unknown> {
  if (!Array.isArray(raw)) throw new Error('Base RPC returned a malformed batch');
  const byId = new Map<number, unknown>();
  for (const item of raw as JsonRpcResponse[]) {
    if (
      typeof item?.id !== 'number' ||
      !expectedIds.includes(item.id) ||
      item.error !== undefined
    ) {
      throw new Error('Base RPC returned an invalid response');
    }
    if (item.result === undefined || byId.has(item.id))
      throw new Error('Base RPC returned an incomplete response');
    byId.set(item.id, item.result);
  }
  if (byId.size !== expectedIds.length || expectedIds.some((id) => !byId.has(id))) {
    throw new Error('Base RPC returned an incomplete response');
  }
  return byId;
}

function uintWord(value: unknown): bigint {
  if (typeof value !== 'string' || !WORD_RE.test(value))
    throw new Error('Base RPC returned a malformed word');
  return BigInt(value);
}

export function formatWad(value: unknown): string {
  const raw = uintWord(value);
  return `${raw / WAD}.${(raw % WAD).toString().padStart(18, '0')}`;
}

function uint8Array(value: unknown): bigint[] {
  if (typeof value !== 'string' || !/^0x(?:[0-9a-fA-F]{64}){2,}$/.test(value)) {
    throw new Error('Base RPC returned a malformed array');
  }
  const words = value.slice(2).match(/.{64}/g) ?? [];
  const offset = BigInt(`0x${words[0]}`);
  const length = Number(BigInt(`0x${words[1]}`));
  if (offset !== 32n || !Number.isSafeInteger(length) || words.length !== 2 + length) {
    throw new Error('Base RPC returned a malformed array');
  }
  return words.slice(2).map((word) => BigInt(`0x${word}`));
}

export function decodeStockAssets(
  entries: readonly StockListEntry[],
  resultsById: ReadonlyMap<number, unknown>,
): StockAsset[] {
  return entries.map((entry, index) => {
    const base = index * CALLS_PER_TOKEN;
    const multiplierRaw = uintWord(resultsById.get(base + 1));
    if (multiplierRaw === 0n) throw new Error(`${entry.symbol} reports a zero multiplier`);
    const pausedFeatures = uint8Array(resultsById.get(base + 2));
    const totalSupply = uintWord(resultsById.get(base + 3));

    return {
      ...entry,
      multiplier: formatWad(resultsById.get(base + 1)),
      issued: totalSupply > 0n,
      transfersPaused: pausedFeatures.includes(PAUSABLE_FEATURE_TRANSFER),
    };
  });
}

async function readStockList(env: Env, request: Request): Promise<StockListEntry[]> {
  const response = await env.ASSETS.fetch(
    new Request(new URL(LIST_PATH, request.url), { method: 'GET' }),
  );
  if (!response.ok) throw new Error(`Stock list asset returned ${response.status}`);
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_LIST_BYTES)
    throw new Error('Stock list is too large');
  const body = await response.text();
  if (body.length > MAX_LIST_BYTES) throw new Error('Stock list is too large');
  return parseStockList(JSON.parse(body));
}

async function callBatch(
  rpc: string,
  batch: readonly JsonRpcRequest[],
): Promise<Map<number, unknown>> {
  const response = await fetch(rpc, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(batch),
    signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Base RPC returned ${response.status}`);
  return rpcResultsById(
    await response.json(),
    batch.map((request) => request.id),
  );
}

async function readAssets(entries: readonly StockListEntry[]): Promise<StockAsset[]> {
  const batch = buildAssetBatch(entries);
  let lastError: unknown;
  for (const rpc of BASE_RPCS) {
    try {
      return decodeStockAssets(entries, await callBatch(rpc, batch));
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error('No Base RPC answered');
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': status === 200 ? CACHE_CONTROL : 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}

export const onRequest: PagesFunction<Env> = async ({ request, env }) => {
  if (request.method !== 'GET') {
    return new Response('Method not allowed', {
      status: 405,
      headers: { allow: 'GET', 'cache-control': 'no-store' },
    });
  }

  let entries: StockListEntry[];
  try {
    entries = await readStockList(env, request);
  } catch {
    return json({ error: 'Coinbase tokenized stock list unavailable' }, 502);
  }

  try {
    return json({ chainId: CHAIN_ID, assets: await readAssets(entries) });
  } catch {
    return json({ error: 'Base RPC unavailable for tokenized stock metadata' }, 502);
  }
};
