/**
 * Resolve an on-chain appData HASH (the bytes32 in a settle() trade) to the full
 * appData DOCUMENT so the decoder can read its Ophis fee + referrer fields.
 *
 * The full document does not live on-chain; only its keccak256 hash does. v1 uses
 * CoW's content-addressed docs API (/api/v1/app_data/{hash}) and RE-HASHES the
 * returned document, rejecting any mismatch. That re-hash guard is the whole point:
 * it demotes the CoW API from a trust root to a liveness-only dependency. A future
 * step (a) is a local Ophis registry of every doc we generate, wired in front of
 * this same call behind the identical seam.
 *
 * Returns:
 *   - the verified fullAppData string, or
 *   - null when the doc is unpinned (404) / shape-invalid / hash-mismatched (DROP), or
 *   - THROWS on a transient/unknown HTTP error, so the caller must NOT advance the
 *     scan cursor over a window it could not fully resolve.
 */
import { keccak256, stringToHex } from 'viem';
import { orderbookBase } from './client.js';

const APP_DATA_TIMEOUT_MS = 10_000;

export async function resolveAppData(chainId: number, hash: `0x${string}`): Promise<string | null> {
  // (a) FUTURE: local Ophis appData registry by hash -> verbatim doc (skipped in v1).
  // (b) CoW content-addressed docs API:
  const res = await fetch(`${orderbookBase(chainId)}/api/v1/app_data/${hash}`, {
    signal: AbortSignal.timeout(APP_DATA_TIMEOUT_MS),
  });
  if (res.status === 404) return null; // unpinned -> lost to v1 (the registry covers it later)
  if (!res.ok) throw new Error(`app_data ${res.status}`); // transient -> do NOT advance cursor
  const body = (await res.json()) as { fullAppData?: unknown };
  const fullAppData = body?.fullAppData;
  if (typeof fullAppData !== 'string') return null;
  // MONEY-PATH GUARD: re-hash the returned document (keccak256 of its UTF-8 bytes,
  // CoW's appData hashing scheme) and reject on any mismatch.
  if (keccak256(stringToHex(fullAppData)) !== hash.toLowerCase()) return null;
  return fullAppData;
}
