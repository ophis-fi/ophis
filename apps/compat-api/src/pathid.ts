/**
 * Stateless pathId tokens.
 *
 * The v3 flow hands the integrator an opaque `pathId` at quote time and takes
 * it back at assemble time. Ophis keeps no server state for this: the token IS
 * the payload, `base64url(payloadJson) + '.' + base64url(hmacSha256(payloadJson, key))`,
 * with `exp = min(iat + 60s, quote expiration)` inside the signed payload.
 *
 * Forgery resistance comes from the HMAC; /sor/submit additionally re-runs the
 * full validation set independently (appData re-hash, receiver guard, uint
 * bounds), so even a leaked key never lets a crafted pathId relay an order the
 * validation set would refuse.
 *
 * Key rotation: verification accepts the current key plus an optional previous
 * key (COMPAT_PATHID_KEY_PREVIOUS), so rotating the secret does not invalidate
 * in-flight quotes inside their at-most-60s window. Minting always uses the
 * current key.
 */
import { CompatError, type PathIdPayload } from './types.js';

/** pathId lifetime cap in seconds (the quote expiration may shorten it further). */
export const PATH_ID_TTL_SECONDS = 60;

const encoder = new TextEncoder();

const b64url = (bytes: Uint8Array): string => {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
};

const fromB64url = (text: string): Uint8Array | null => {
  const padded = text.replaceAll('-', '+').replaceAll('_', '/');
  try {
    const bin = atob(padded);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
};

const importHmacKey = (secret: string): Promise<CryptoKey> =>
  crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ]);

export async function mintPathId(payload: PathIdPayload, secret: string): Promise<string> {
  const key = await importHmacKey(secret);
  const body = encoder.encode(JSON.stringify(payload));
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, body));
  return `${b64url(body)}.${b64url(mac)}`;
}

/**
 * Verifies a pathId against the accepted keys (current first, then previous)
 * and returns its payload. Throws PATH_ID_INVALID on malformed or forged
 * tokens and PATH_ID_EXPIRED when the signed expiry has passed. Verification
 * uses crypto.subtle.verify, so MAC comparison is not caller-timed.
 */
export async function verifyPathId(
  token: string,
  secrets: readonly string[],
  nowSeconds: number,
): Promise<PathIdPayload> {
  const invalid = (): CompatError =>
    new CompatError('PATH_ID_INVALID', 'pathId is malformed or was not issued by this service.');

  if (typeof token !== 'string' || token.length > 8192) throw invalid();
  const parts = token.split('.');
  if (parts.length !== 2) throw invalid();
  const body = fromB64url(parts[0]);
  const mac = fromB64url(parts[1]);
  if (!body || !mac) throw invalid();

  let verified = false;
  for (const secret of secrets) {
    if (!secret) continue;
    const key = await importHmacKey(secret);
    const buf = new Uint8Array(mac);
    if (await crypto.subtle.verify('HMAC', key, buf, new Uint8Array(body))) {
      verified = true;
      break;
    }
  }
  if (!verified) throw invalid();

  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(body));
  } catch {
    throw invalid();
  }
  const p = payload as Partial<PathIdPayload> | null;
  const pfOk =
    p?.pf === null ||
    p?.pf === undefined ||
    (typeof p.pf === 'object' &&
      typeof (p.pf as { volumeBps?: unknown }).volumeBps === 'number' &&
      Number.isInteger((p.pf as { volumeBps: number }).volumeBps) &&
      typeof (p.pf as { recipient?: unknown }).recipient === 'string');
  if (
    !p ||
    p.v !== 1 ||
    typeof p.cid !== 'number' ||
    typeof p.st !== 'string' ||
    typeof p.bt !== 'string' ||
    typeof p.ssa !== 'string' ||
    typeof p.sba !== 'string' ||
    typeof p.qba !== 'string' ||
    typeof p.fee !== 'string' ||
    typeof p.slp !== 'number' ||
    typeof p.iat !== 'number' ||
    typeof p.exp !== 'number' ||
    (p.usr !== null && typeof p.usr !== 'string') ||
    (p.ref !== null && typeof p.ref !== 'string') ||
    (p.qid !== null && typeof p.qid !== 'number') ||
    !pfOk
  ) {
    throw invalid();
  }
  if (nowSeconds > p.exp) {
    throw new CompatError(
      'PATH_ID_EXPIRED',
      `pathId expired at ${p.exp} (unix seconds). Request a fresh quote from /sor/quote/v3.`,
    );
  }
  // Older tokens minted before the partner-fee mapping carry no `pf`; treat as null.
  return { ...p, pf: p.pf ?? null } as PathIdPayload;
}
