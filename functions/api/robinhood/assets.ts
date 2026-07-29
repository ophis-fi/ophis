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

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function isTradingCapabilities(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;

  return Object.values(value).every(
    (session) =>
      session === undefined ||
      (session !== null &&
        typeof session === 'object' &&
        !Array.isArray(session) &&
        Object.values(session).every(
          (status) => status === undefined || typeof status === 'string',
        )),
  );
}

export function isRobinhoodAsset(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;

  const asset = value as Record<string, unknown>;
  if (
    typeof asset.id !== 'string' ||
    typeof asset.tokenSymbol !== 'string' ||
    typeof asset.tokenName !== 'string' ||
    typeof asset.status !== 'string' ||
    typeof asset.currentMultiplier !== 'string' ||
    !MULTIPLIER.test(asset.currentMultiplier) ||
    !isOptionalString(asset.pendingMultiplier) ||
    (typeof asset.pendingMultiplier === 'string' && !MULTIPLIER.test(asset.pendingMultiplier)) ||
    !isOptionalString(asset.pendingMultiplierEffectiveTime) ||
    !isOptionalString(asset.logoUrl) ||
    !isTradingCapabilities(asset.tradingCapabilities) ||
    !Array.isArray(asset.deployments) ||
    asset.deployments.length === 0
  ) {
    return false;
  }

  return asset.deployments.every(
    (deployment) =>
      deployment !== null &&
      typeof deployment === 'object' &&
      !Array.isArray(deployment) &&
      Number.isSafeInteger((deployment as Record<string, unknown>).chainId) &&
      typeof (deployment as Record<string, unknown>).contractAddress === 'string' &&
      ADDRESS.test((deployment as Record<string, unknown>).contractAddress as string),
  );
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
    const payload = (await response.json()) as Partial<RobinhoodAssetsPayload>;
    if (
      !Array.isArray(payload.assets) ||
      payload.assets.length > MAX_ASSETS ||
      !payload.assets.every(isRobinhoodAsset)
    ) {
      throw new Error('invalid payload');
    }
    return json({ assets: payload.assets });
  } catch {
    return json({ error: 'Invalid Robinhood asset registry response' }, 502);
  }
};
