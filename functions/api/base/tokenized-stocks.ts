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
 * Successful snapshots are stored in the Cache API under a canonical key (a
 * Cache-Control header alone does not populate the Pages edge cache for a
 * generated response), so one RPC snapshot serves every client for the cache
 * window instead of every browser refresh fanning out 39 eth_calls.
 *
 * Reference: https://docs.base.org/base-chain/asset-issuance/tokenized-stocks-on-base
 */

const CHAIN_ID = 8453;
const LIST_PATH = '/token-lists/coinbase-tokenized-stocks.json';
const BASE_RPCS = [
  'https://base-rpc.publicnode.com',
  'https://base.drpc.org',
  'https://mainnet.base.org',
];
// Official Base deployment: https://github.com/mds1/multicall3/blob/main/deployments.json
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
// No stale-while-revalidate: this payload is presented as contract-verified pause and
// multiplier state, so a failed revalidation must surface as a 502 (which the panel shows as
// "unavailable") rather than an hour of an old snapshot served as a fresh 200.
const CACHE_SECONDS = 300;
const CACHE_CONTROL = `public, max-age=60, s-maxage=${CACHE_SECONDS}`;
const RPC_TIMEOUT_MS = 4_000;
const MAX_LIST_BYTES = 200_000;
const MAX_RPC_RESPONSE_BYTES = 262_144;
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

interface Env {
  ASSETS: Fetcher;
}

interface CloudflareCacheStorage extends CacheStorage {
  default: Cache;
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

const abiWord = (value: number): string => value.toString(16).padStart(64, '0');

export function buildAssetCall(entries: readonly StockListEntry[]): JsonRpcRequest {
  // aggregate((address,bytes)[]): each no-argument view has exactly four calldata bytes.
  const calls = entries.flatMap(({ address }) => SELECTORS.map((selector) =>
    address.slice(2).toLowerCase().padStart(64, '0') + abiWord(64) + abiWord(4) +
    selector.slice(2).padEnd(64, '0'),
  ));
  const offsets = calls.map((_, index) => abiWord(calls.length * 32 + index * 128));
  return {
    jsonrpc: '2.0', id: 1, method: 'eth_call',
    params: [{
      to: MULTICALL3,
      data: '0x252dba42' + abiWord(32) + abiWord(calls.length) + offsets.join('') + calls.join(''),
    }, 'latest'],
  };
}

export function decodeAggregate(raw: unknown, count: number): Map<number, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new Error('Base RPC returned an invalid response');
  const { id, result, error } = raw as { id?: unknown; result?: unknown; error?: unknown };
  if (id !== 1 || error !== undefined || typeof result !== 'string' ||
      !/^0x(?:[0-9a-fA-F]{64}){3,}$/.test(result))
    throw new Error('Base RPC returned an invalid response');

  // (uint256 blockNumber, bytes[] returnData). These views return whole ABI words;
  // require canonical, contiguous offsets and exact lengths, not a general ABI decoder.
  const words = result.slice(2).match(/.{64}/g)!;
  const word = (index: number): bigint => uintWord(`0x${words[index]}`);
  if (word(1) !== 64n || word(2) !== BigInt(count))
    throw new Error('Base RPC returned an invalid aggregate');
  const results = new Map<number, unknown>();
  let cursor = 3 + count;
  for (let index = 0; index < count; index++) {
    if (word(3 + index) !== BigInt((cursor - 3) * 32))
      throw new Error('Base RPC returned an invalid aggregate offset');
    const bytes = word(cursor++);
    if (bytes === 0n || bytes % 32n !== 0n || bytes > BigInt((words.length - cursor) * 32))
      throw new Error('Base RPC returned an invalid aggregate length');
    const end = cursor + Number(bytes / 32n);
    results.set(index + 1, `0x${words.slice(cursor, end).join('')}`);
    cursor = end;
  }
  if (cursor !== words.length) throw new Error('Base RPC returned trailing aggregate data');
  return results;
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

/** Buffers at most `maxBytes` of a remote body; a larger (or lying) body is rejected, not parsed. */
export async function readLimitedBody(response: Response, maxBytes: number): Promise<string> {
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes)
    throw new Error('Remote response is too large');
  if (!response.body) return '';

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let body = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) return body + decoder.decode();
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new Error('Remote response is too large');
    }
    body += decoder.decode(value, { stream: true });
  }
}

async function readStockList(env: Env, request: Request): Promise<StockListEntry[]> {
  const response = await env.ASSETS.fetch(
    new Request(new URL(LIST_PATH, request.url), { method: 'GET' }),
  );
  if (!response.ok) throw new Error(`Stock list asset returned ${response.status}`);
  return parseStockList(JSON.parse(await readLimitedBody(response, MAX_LIST_BYTES)));
}

async function callAggregate(
  rpc: string,
  call: JsonRpcRequest,
  count: number,
): Promise<Map<number, unknown>> {
  const response = await fetch(rpc, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(call),
    signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
  });
  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    throw new Error(`Base RPC returned HTTP ${response.status}`);
  }
  return decodeAggregate(
    JSON.parse(await readLimitedBody(response, MAX_RPC_RESPONSE_BYTES)),
    count,
  );
}

async function readAssets(entries: readonly StockListEntry[]): Promise<StockAsset[]> {
  // One eth_call gives a same-block snapshot without public RPC batch limits or 39 requests.
  const call = buildAssetCall(entries);
  let lastError: unknown;
  for (const url of BASE_RPCS) {
    try {
      const results = await callAggregate(url, call, entries.length * CALLS_PER_TOKEN);
      // Never mix partial snapshots from different providers or return partial assets.
      return decodeStockAssets(entries, results);
    } catch (error) {
      lastError = error;
      console.warn(JSON.stringify({
        event: 'base-stock-rpc-failed',
        provider: new URL(url).hostname,
        // JSON parser errors can quote response bodies. Do not log those or stack traces.
        reason: error instanceof SyntaxError
          ? 'Invalid RPC JSON'
          : error instanceof Error
            ? error.message.replace(/\s+/g, ' ').slice(0, 200)
            : 'Unknown RPC error',
      }));
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

function edgeCache(): Cache | undefined {
  // Some Pages direct-upload runtimes omit the Cache API global; the live path must still work.
  return typeof caches === 'undefined' ? undefined : (caches as CloudflareCacheStorage).default;
}

function cacheKey(request: Request): Request {
  const url = new URL(request.url);
  url.search = '';
  return new Request(url, { method: 'GET' });
}

async function safeCacheMatch(
  cache: Cache | undefined,
  key: Request,
): Promise<Response | undefined> {
  if (!cache) return undefined;
  try {
    return (await cache.match(key)) ?? undefined;
  } catch {
    return undefined;
  }
}

async function safeCachePut(
  cache: Cache | undefined,
  key: Request,
  response: Response,
): Promise<void> {
  if (!cache) return;
  try {
    await cache.put(key, response);
  } catch {
    // The live response remains valid even when an edge cannot persist it.
  }
}

export const onRequest: PagesFunction<Env> = async ({ request, env, waitUntil }) => {
  if (request.method !== 'GET') {
    return new Response('Method not allowed', {
      status: 405,
      headers: { allow: 'GET', 'cache-control': 'no-store' },
    });
  }

  const cache = edgeCache();
  const key = cacheKey(request);
  const cached = await safeCacheMatch(cache, key);
  if (cached) return cached;

  let entries: StockListEntry[];
  try {
    entries = await readStockList(env, request);
  } catch {
    return json({ error: 'Coinbase tokenized stock list unavailable' }, 502);
  }

  try {
    const response = json({ chainId: CHAIN_ID, assets: await readAssets(entries) });
    waitUntil(safeCachePut(cache, key, response.clone()));
    return response;
  } catch {
    return json({ error: 'Base RPC unavailable for tokenized stock metadata' }, 502);
  }
};
