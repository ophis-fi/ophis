/**
 * GET /api/robinhood/assets
 *
 * Same-origin, cached facade for Robinhood's public Stock Token registry.
 * The first-party API intentionally does not emit browser CORS headers, so the
 * swap UI cannot consume it directly. This endpoint exposes only the documented
 * asset payload and fails closed if the upstream shape changes.
 */

const UPSTREAM = 'https://api.robinhood.com/rhj/assets';
const CACHE_CONTROL = 'public, max-age=60, s-maxage=300, stale-while-revalidate=3600';

interface RobinhoodAssetsPayload {
  assets: unknown[];
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const MULTIPLIER = /^(?:0|[1-9]\d{0,29})(?:\.\d{1,18})?$/;
const MAX_ASSETS = 500;
const MAX_RESPONSE_BYTES = 1_000_000;
const MAX_DEPLOYMENTS = 8;
const MAX_CAPABILITY_SESSIONS = 8;
const MAX_CAPABILITY_TYPES = 8;

interface SanitizedDeployment {
  chainId: number;
  contractAddress: string;
}

interface SanitizedAsset {
  id: string;
  tokenSymbol: string;
  tokenName: string;
  deployments: SanitizedDeployment[];
  currentMultiplier: string;
  pendingMultiplier?: string;
  pendingMultiplierEffectiveTime?: string;
  logoUrl?: string;
  status: string;
  tradingCapabilities?: Record<string, Record<string, string | undefined>>;
}

function boundedString(value: unknown, maxLength: number): string | undefined {
  return typeof value === 'string' && value.length <= maxLength ? value : undefined;
}

function positiveMultiplier(value: unknown): value is string {
  return typeof value === 'string' && MULTIPLIER.test(value) && BigInt(value.replace('.', '')) > 0n;
}

async function readLimitedBody(response: Response): Promise<string> {
  if (!response.body) return '';

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let body = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) return body + decoder.decode();
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error('response too large');
    }
    body += decoder.decode(value, { stream: true });
  }
}

function sanitizeTradingCapabilities(
  value: unknown,
): SanitizedAsset['tradingCapabilities'] | undefined | false {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;

  const sessions = Object.entries(value);
  if (sessions.length > MAX_CAPABILITY_SESSIONS) return false;
  const sanitized: NonNullable<SanitizedAsset['tradingCapabilities']> = {};
  for (const [sessionName, session] of sessions) {
    if (
      sessionName.length > 32 ||
      !session ||
      typeof session !== 'object' ||
      Array.isArray(session)
    ) {
      return false;
    }
    const capabilityEntries = Object.entries(session);
    if (capabilityEntries.length > MAX_CAPABILITY_TYPES) return false;
    const capabilities: Record<string, string | undefined> = {};
    for (const [capabilityName, status] of capabilityEntries) {
      if (
        capabilityName.length > 32 ||
        (status !== undefined && boundedString(status, 64) === undefined)
      ) {
        return false;
      }
      capabilities[capabilityName] = status as string | undefined;
    }
    sanitized[sessionName] = capabilities;
  }
  return sanitized;
}

export function sanitizeRobinhoodAsset(value: unknown): SanitizedAsset | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;

  const asset = value as Record<string, unknown>;
  const id = boundedString(asset.id, 128);
  const tokenSymbol = boundedString(asset.tokenSymbol, 32);
  const tokenName = boundedString(asset.tokenName, 256);
  const status = boundedString(asset.status, 64);
  const pendingMultiplier =
    asset.pendingMultiplier === undefined ? undefined : boundedString(asset.pendingMultiplier, 64);
  const pendingMultiplierEffectiveTime =
    asset.pendingMultiplierEffectiveTime === undefined
      ? undefined
      : boundedString(asset.pendingMultiplierEffectiveTime, 64);
  const logoUrl = asset.logoUrl === undefined ? undefined : boundedString(asset.logoUrl, 2_048);
  const tradingCapabilities = sanitizeTradingCapabilities(asset.tradingCapabilities);

  if (
    id === undefined ||
    tokenSymbol === undefined ||
    tokenName === undefined ||
    status === undefined ||
    !positiveMultiplier(asset.currentMultiplier) ||
    (asset.pendingMultiplier !== undefined && pendingMultiplier === undefined) ||
    (pendingMultiplier !== undefined &&
      pendingMultiplier !== '' &&
      !MULTIPLIER.test(pendingMultiplier)) ||
    (asset.pendingMultiplierEffectiveTime !== undefined &&
      pendingMultiplierEffectiveTime === undefined) ||
    (asset.logoUrl !== undefined && logoUrl === undefined) ||
    tradingCapabilities === false ||
    !Array.isArray(asset.deployments) ||
    asset.deployments.length === 0 ||
    asset.deployments.length > MAX_DEPLOYMENTS
  ) {
    return undefined;
  }

  const deployments: SanitizedDeployment[] = [];
  for (const value of asset.deployments) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const deployment = value as Record<string, unknown>;
    if (
      !Number.isSafeInteger(deployment.chainId) ||
      typeof deployment.contractAddress !== 'string' ||
      !ADDRESS.test(deployment.contractAddress)
    ) {
      return undefined;
    }
    deployments.push({
      chainId: deployment.chainId as number,
      contractAddress: deployment.contractAddress,
    });
  }

  return {
    id,
    tokenSymbol,
    tokenName,
    deployments,
    currentMultiplier: asset.currentMultiplier,
    ...(pendingMultiplier === undefined ? {} : { pendingMultiplier }),
    ...(pendingMultiplierEffectiveTime === undefined ? {} : { pendingMultiplierEffectiveTime }),
    ...(logoUrl === undefined ? {} : { logoUrl }),
    status,
    ...(tradingCapabilities === undefined ? {} : { tradingCapabilities }),
  };
}

export function isRobinhoodAsset(value: unknown): boolean {
  return sanitizeRobinhoodAsset(value) !== undefined;
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

export const onRequest: PagesFunction = async ({ request }) => {
  if (request.method !== 'GET') {
    return new Response('Method not allowed', {
      status: 405,
      headers: { allow: 'GET', 'cache-control': 'no-store' },
    });
  }

  let response: Response;
  try {
    response = await fetch(UPSTREAM, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    return json({ error: 'Robinhood asset registry unavailable' }, 502);
  }

  if (!response.ok) {
    return json({ error: 'Robinhood asset registry unavailable' }, 502);
  }

  try {
    const contentLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
      throw new Error('response too large');
    }
    const body = await readLimitedBody(response);
    const payload = JSON.parse(body) as Partial<RobinhoodAssetsPayload>;
    if (!Array.isArray(payload.assets) || payload.assets.length > MAX_ASSETS) {
      throw new Error('invalid payload');
    }
    const assets = payload.assets.map(sanitizeRobinhoodAsset);
    if (assets.some((asset) => asset === undefined)) throw new Error('invalid asset');
    return json({ assets });
  } catch {
    return json({ error: 'Invalid Robinhood asset registry response' }, 502);
  }
};
