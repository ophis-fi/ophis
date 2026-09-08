import { timingSafeEqual } from 'node:crypto';

export type OtcControlValue =
  | { enabled: boolean; expiresAt: number; mode?: never }
  | { enabled: true; mode: 'public'; expiresAt: null };

export interface ControlStorage {
  read(): Promise<unknown>;
  write(value: OtcControlValue): Promise<void>;
}

function enabled(value: unknown): value is OtcControlValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const control = value as Record<string, unknown>;
  if (control.enabled !== true) return false;
  // Public service is explicitly persistent; expiring trial controls keep their 24-hour bound.
  if (control.mode === 'public') return control.expiresAt === null;
  const now = Date.now();
  return (
    control.mode === undefined &&
    typeof control.expiresAt === 'number' &&
    Number.isSafeInteger(control.expiresAt) &&
    control.expiresAt > now &&
    control.expiresAt <= now + 86_400_000
  );
}

export async function handleControl(
  request: Request,
  storage: ControlStorage,
  token: string | undefined,
): Promise<Response> {
  const url = new URL(request.url);
  const nonce = url.searchParams.get('nonce');
  const headers = { 'cache-control': 'no-store, max-age=0', 'cdn-cache-control': 'no-store' };
  const reply = (active: boolean, status = 200) =>
    Response.json({ enabled: active, nonce }, { status, headers });
  if (url.origin !== 'https://swap.ophis.fi' || url.pathname !== '/api/otc-control')
    return reply(false, 404);
  if (!nonce || !/^[a-f0-9]{32}$/.test(nonce)) return reply(false, 400);
  try {
    if (request.method === 'POST') {
      const supplied = new TextEncoder().encode(request.headers.get('authorization') ?? '');
      const expected = new TextEncoder().encode(`Bearer ${token}`);
      if (
        !token ||
        token.length < 64 ||
        supplied.length !== expected.length ||
        !timingSafeEqual(supplied, expected)
      )
        return reply(false, 403);
      if (Number(request.headers.get('content-length') ?? 'Infinity') > 1_024)
        return reply(false, 413);
      const value: unknown = await request.json();
      if (enabled(value)) await storage.write(value);
      else if (value && typeof value === 'object' && 'enabled' in value && value.enabled === false)
        await storage.write({ enabled: false, expiresAt: 0 });
      else return reply(false, 400);
    } else if (request.method !== 'GET') return reply(false, 405);
    return reply(enabled(await storage.read()));
  } catch {
    return reply(false, 503);
  }
}
