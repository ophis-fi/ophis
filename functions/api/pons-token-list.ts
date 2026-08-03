/**
 * GET /api/pons-token-list
 *
 * Adapts the live pons Explore catalog to the standard Uniswap token-list
 * shape consumed by the existing Manage Lists UI. pons launches are
 * permissionless, so inclusion is discovery only and never an endorsement.
 *
 * The upstream index is only a convenience transport. Entries must match the
 * factories and WETH pair documented by pons; malformed metadata is dropped.
 */

const CHAIN_ID = 4663;
const PONS_ORIGIN = 'https://www.ponsfamily.com';
const ROBINHOOD_RPC = 'https://rpc.mainnet.chain.robinhood.com';
const UPSTREAM_URL =
  `${PONS_ORIGIN}/api/pons-launches?explore=1&sort=recentBuys&age=all&page=1&pageSize=100` +
  '&graduatedPage=1&graduatedPageSize=1&includeGraduated=0&v=10';
const PONS_LOGO = `${PONS_ORIGIN}/icon.png`;
const WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73';
const GET_LAUNCHED_TOKEN_SELECTOR = '3cf28b5a';
const FACTORIES = new Set([
  '0xa5aab3f0c6eeadf30ef1d3eb997108e976351feb',
  '0x0c37a24f5d23a486fa692d1500881d698b1f77a4',
]);
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const MAX_TEXT_LENGTH = 100;
const TIMEOUT_MS = 12_000;
const CACHE_SECONDS = 300;
const LAST_KNOWN_GOOD_SECONDS = 86_400;
const RPC_BATCH_SIZE = 20;
const RPC_CONCURRENCY = 2;
const REFERENCE_PONS: PonsLaunch = {
  factory: '0x0c37a24F5D23A486FA692d1500881d698B1F77a4',
  token: '0x39dBED3a2bd333467115dE45665cC57F813C4571',
  pairToken: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73',
  name: 'Pons',
  symbol: 'PONS',
  logo: 'ipfs://bafybeiehcgbqotmir6tqi76eorpihucphlry53cx3mmnxgmqjjxpwherwq',
};

interface PonsLaunch {
  factory?: unknown;
  token?: unknown;
  pairToken?: unknown;
  name?: unknown;
  symbol?: unknown;
  logo?: unknown;
}

interface TokenListToken {
  chainId: number;
  address: string;
  name: string;
  symbol: string;
  decimals: number;
  logoURI?: string;
}

interface PonsTokenList {
  name: string;
  timestamp: string;
  version: { major: number; minor: number; patch: number };
  logoURI: string;
  keywords: string[];
  tokens: TokenListToken[];
}

interface JsonRpcResponse {
  id?: unknown;
  result?: unknown;
  error?: unknown;
}

interface CloudflareCacheStorage extends CacheStorage {
  default: Cache;
}

function cleanText(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const cleaned = value
    .replace(/[<>\u0000-\u001F\u007F]/g, '')
    .trim()
    .slice(0, MAX_TEXT_LENGTH);
  return cleaned || fallback;
}

function safeLogo(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 420) return undefined;
  if (value.startsWith('ipfs://') && /^ipfs:\/\/[a-zA-Z0-9/._-]+$/.test(value)) return value;
  // Launch creators control this field. Only accept content-addressed IPFS
  // assets so a list entry cannot turn the token selector into a third-party
  // tracking beacon. The frontend resolves IPFS through its trusted gateways.
  return undefined;
}

function launchArrays(raw: unknown): PonsLaunch[] {
  if (Array.isArray(raw)) return raw as PonsLaunch[];
  if (!raw || typeof raw !== 'object') return [];
  const response = raw as { active?: { items?: unknown }; graduated?: { items?: unknown } };
  const active = Array.isArray(response.active?.items) ? response.active.items : [];
  const graduated = Array.isArray(response.graduated?.items) ? response.graduated.items : [];
  return [...active, ...graduated] as PonsLaunch[];
}

export function parsePonsCatalog(raw: unknown): PonsLaunch[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Pons catalog returned a malformed response');
  }
  const response = raw as { active?: { items?: unknown } };
  if (!response.active || !Array.isArray(response.active.items)) {
    throw new Error('Pons catalog returned a malformed response');
  }
  return response.active.items.filter(
    (item): item is PonsLaunch => !!item && typeof item === 'object' && !Array.isArray(item),
  );
}

export function ponsTokenListFromResponse(raw: unknown, now = new Date()): PonsTokenList {
  const seen = new Set<string>();
  const tokens: TokenListToken[] = [];

  for (const launch of launchArrays(raw)) {
    if (!launch || typeof launch !== 'object') continue;
    if (typeof launch.factory !== 'string' || !FACTORIES.has(launch.factory.toLowerCase()))
      continue;
    if (typeof launch.pairToken !== 'string' || launch.pairToken.toLowerCase() !== WETH) continue;
    if (typeof launch.token !== 'string' || !ADDRESS_RE.test(launch.token)) continue;
    const addressKey = launch.token.toLowerCase();
    if (seen.has(addressKey)) continue;

    const symbol = cleanText(launch.symbol, 'UNKNOWN').slice(0, 80);
    const token: TokenListToken = {
      chainId: CHAIN_ID,
      address: launch.token,
      name: cleanText(launch.name, symbol),
      symbol,
      decimals: 18,
    };
    const logoURI = safeLogo(launch.logo);
    if (logoURI) token.logoURI = logoURI;
    seen.add(addressKey);
    tokens.push(token);
  }

  return {
    name: 'Pons Recent Launches',
    timestamp: now.toISOString(),
    version: { major: 1, minor: 0, patch: Math.floor(now.getTime() / 300_000) },
    logoURI: PONS_LOGO,
    keywords: ['pons', 'robinhood', 'launches'],
    tokens,
  };
}

function word(result: string, index: number): string {
  const start = 2 + index * 64;
  return result.slice(start, start + 64);
}

export function isVerifiedLaunchResult(launch: PonsLaunch, result: unknown): boolean {
  if (
    typeof launch.token !== 'string' ||
    typeof result !== 'string' ||
    !/^0x[0-9a-fA-F]{832}$/.test(result)
  ) {
    return false;
  }
  const token = `0x${word(result, 0).slice(24)}`.toLowerCase();
  const pairToken = `0x${word(result, 2).slice(24)}`.toLowerCase();
  const exists = BigInt(`0x${word(result, 11)}`) === 1n;
  return token === launch.token.toLowerCase() && pairToken === WETH && exists;
}

export function rpcResultsById(raw: unknown, expectedIds: number[]): Map<number, unknown> {
  if (!Array.isArray(raw)) throw new Error('Robinhood RPC returned a malformed batch');
  const byId = new Map<number, unknown>();
  for (const item of raw as JsonRpcResponse[]) {
    if (
      typeof item?.id !== 'number' ||
      !expectedIds.includes(item.id) ||
      item.error !== undefined
    ) {
      throw new Error('Robinhood RPC returned an invalid response');
    }
    if (item.result === undefined || byId.has(item.id)) {
      throw new Error('Robinhood RPC returned an incomplete response');
    }
    byId.set(item.id, item.result);
  }
  if (byId.size !== expectedIds.length || expectedIds.some((id) => !byId.has(id))) {
    throw new Error('Robinhood RPC returned an incomplete response');
  }
  return byId;
}

async function verifyLaunchesOnchain(
  launches: PonsLaunch[],
  signal: AbortSignal,
): Promise<PonsLaunch[]> {
  const candidates = launches.filter(
    (launch) =>
      typeof launch.factory === 'string' &&
      FACTORIES.has(launch.factory.toLowerCase()) &&
      typeof launch.token === 'string' &&
      ADDRESS_RE.test(launch.token),
  );
  const chunks = Array.from({ length: Math.ceil(candidates.length / RPC_BATCH_SIZE) }, (_, index) =>
    candidates.slice(index * RPC_BATCH_SIZE, (index + 1) * RPC_BATCH_SIZE),
  );

  const verifiedChunks: PonsLaunch[][] = [];
  const verifyChunk = async (chunk: PonsLaunch[], chunkIndex: number): Promise<PonsLaunch[]> => {
    const requests = chunk.map((launch, itemIndex) => ({
      jsonrpc: '2.0',
      id: chunkIndex * RPC_BATCH_SIZE + itemIndex,
      method: 'eth_call',
      params: [
        {
          to: launch.factory,
          data: `0x${GET_LAUNCHED_TOKEN_SELECTOR}${String(launch.token).slice(2).toLowerCase().padStart(64, '0')}`,
        },
        'latest',
      ],
    }));
    const response = await fetch(ROBINHOOD_RPC, {
      method: 'POST',
      signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(requests),
    });
    if (!response.ok) throw new Error('Robinhood RPC verification failed');
    const raw: unknown = await response.json();
    const byId = rpcResultsById(
      raw,
      requests.map(({ id }) => id),
    );
    return chunk.filter((launch, itemIndex) =>
      isVerifiedLaunchResult(launch, byId.get(chunkIndex * RPC_BATCH_SIZE + itemIndex)),
    );
  };

  // Robinhood's public RPC intermittently rate-limits a six-request burst.
  // Two-way bounded concurrency avoids that burst without accumulating all six
  // RPC latencies under the shared end-to-end deadline.
  for (let start = 0; start < chunks.length; start += RPC_CONCURRENCY) {
    const group = chunks.slice(start, start + RPC_CONCURRENCY);
    verifiedChunks.push(
      ...(await Promise.all(group.map((chunk, offset) => verifyChunk(chunk, start + offset)))),
    );
  }
  return verifiedChunks.flat();
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: {
      'access-control-allow-origin': '*',
      'cache-control': `public, max-age=60, s-maxage=${CACHE_SECONDS}, stale-while-revalidate=86400`,
      'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
      'x-content-type-options': 'nosniff',
    },
  });
}

function cacheResponse(response: Response, maxAge: number): Response {
  const cached = response.clone();
  const headers = new Headers(cached.headers);
  headers.set('cache-control', `public, max-age=${maxAge}`);
  return new Response(cached.body, {
    status: cached.status,
    statusText: cached.statusText,
    headers,
  });
}

function serveCached(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set(
    'cache-control',
    `public, max-age=60, s-maxage=${CACHE_SECONDS}, stale-while-revalidate=86400`,
  );
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function safeCacheMatch(cache: Cache, key: Request): Promise<Response | undefined> {
  try {
    return (await cache.match(key)) ?? undefined;
  } catch {
    // Cache availability must never take down live token discovery.
    return undefined;
  }
}

async function safeCachePut(cache: Cache, key: Request, response: Response): Promise<void> {
  try {
    await cache.put(key, response);
  } catch {
    // The live response remains valid even when an edge cannot persist it.
  }
}

export const onRequestGet: PagesFunction = async (context) => {
  const cache = (caches as CloudflareCacheStorage).default;
  const cacheUrl = new URL(context.request.url);
  cacheUrl.search = '';
  const cacheKey = new Request(cacheUrl, { method: 'GET' });
  const staleUrl = new URL(cacheUrl);
  staleUrl.pathname = `${staleUrl.pathname}.__last_known_good`;
  const staleKey = new Request(staleUrl, { method: 'GET' });
  const cached = await safeCacheMatch(cache, cacheKey);
  if (cached) return serveCached(cached);

  const unavailable = async (): Promise<Response> => {
    const stale = await safeCacheMatch(cache, staleKey);
    return stale
      ? serveCached(stale)
      : json({ error: 'Pons catalog is temporarily unavailable.' }, 502);
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const activeResponse = await fetch(UPSTREAM_URL, {
      signal: controller.signal,
      headers: { accept: 'application/json', 'user-agent': 'Ophis pons token-list adapter' },
    });
    if (!activeResponse.ok) return unavailable();
    const active = await activeResponse.json();
    const verified = await verifyLaunchesOnchain(
      [REFERENCE_PONS, ...parsePonsCatalog(active)],
      controller.signal,
    );
    const list = ponsTokenListFromResponse(verified);
    if (
      !list.tokens.some(
        ({ address }) => address.toLowerCase() === String(REFERENCE_PONS.token).toLowerCase(),
      )
    ) {
      throw new Error('Reference Pons launch could not be verified');
    }
    const result = json(list);
    context.waitUntil(
      Promise.all([
        safeCachePut(cache, cacheKey, cacheResponse(result, CACHE_SECONDS)),
        safeCachePut(cache, staleKey, cacheResponse(result, LAST_KNOWN_GOOD_SECONDS)),
      ]).then(() => undefined),
    );
    return result;
  } catch {
    return unavailable();
  } finally {
    clearTimeout(timer);
  }
};

export const onRequest: PagesFunction = ({ request }) =>
  json({ error: `Method ${request.method} is not allowed.` }, 405);
