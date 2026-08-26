/**
 * Resolve an on-chain appData HASH (the bytes32 in a settle() trade) to the full
 * appData DOCUMENT so the decoder can read its Ophis fee + referrer fields.
 *
 * The full document does not live on-chain; only its keccak256 hash does. v1 uses
 * a local archive or CoW's content-addressed docs API (/api/v1/app_data/{hash})
 * and RE-HASHES the returned document, rejecting any mismatch. That re-hash guard
 * is the whole point: both sources are liveness aids, never trust roots.
 *
 * Returns:
 *   - the verified fullAppData string, or
 *   - null when the doc is unpinned (404) / shape-invalid / hash-mismatched (DROP), or
 *   - THROWS on a transient/unknown HTTP error, so the caller must NOT advance the
 *     scan cursor over a window it could not fully resolve.
 */
import { keccak256, stringToHex } from 'viem';
import {
  OPTIMISM_CHAIN_ID,
  ROBINHOOD_CHAIN_ID,
  UNICHAIN_CHAIN_ID,
  orderbookBase,
} from './client.js';
import { resolveLegacyAppData } from './legacyAppDataRegistry.js';

const APP_DATA_TIMEOUT_MS = 10_000;

export async function resolveAppData(chainId: number, hash: `0x${string}`): Promise<string | null> {
  const archived = resolveLegacyAppData(hash);
  if (archived !== null) return archived;

  // A sovereign orderbook may be rebuilt or prune its own document while another
  // Ophis content store still retains the same hash. Query the order's native
  // store first, then the other sovereign stores. Re-hashing makes this safe: a
  // fallback can provide availability, but cannot alter the signed document.
  const sovereign = [OPTIMISM_CHAIN_ID, UNICHAIN_CHAIN_ID, ROBINHOOD_CHAIN_ID];
  const bases = [
    orderbookBase(chainId),
    ...(sovereign.includes(chainId) ? sovereign.map(orderbookBase) : []),
  ].filter((base, index, all) => all.indexOf(base) === index);

  let transientError: Error | null = null;
  for (const base of bases) {
    let res: Response;
    try {
      res = await fetch(`${base}/api/v1/app_data/${hash}`, {
        signal: AbortSignal.timeout(APP_DATA_TIMEOUT_MS),
      });
    } catch (err) {
      transientError ??= err instanceof Error ? err : new Error(String(err));
      continue;
    }
    if (res.status === 404) continue;
    if (!res.ok) {
      transientError ??= new Error(`app_data ${res.status}`);
      continue;
    }
    const body = (await res.json()) as { fullAppData?: unknown };
    const fullAppData = body?.fullAppData;
    if (typeof fullAppData !== 'string') continue;
    // MONEY-PATH GUARD: keccak256 of the exact UTF-8 bytes must equal the hash
    // signed into settle() calldata.
    if (keccak256(stringToHex(fullAppData)) === hash.toLowerCase()) return fullAppData;
  }
  if (transientError) throw transientError; // caller must not advance its cursor
  return null;
}
