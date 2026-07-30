/**
 * Per-chain viem read client for the on-chain settle() decoder.
 *
 * dRPC primary (keyed free, eth_getLogs flat 20 CU, archive) + PublicNode keyless
 * fallback, wired through viem's `fallback` transport so a single provider going
 * down or rate-limiting does not stall the decoder. Read-only: getLogs,
 * getTransaction, getBlock, getBlockNumber. No `chain` is needed for raw reads.
 *
 * Config precedence per chain:
 *   primary  = SETTLE_RPC_URL_<chainId>  ||  dRPC built from DRPC_API_KEY
 *   fallback = SETTLE_RPC_FALLBACK_<chainId>  ||  a known keyless archive default
 */
import { createPublicClient, fallback, http, type PublicClient } from 'viem';

// chainId -> dRPC network slug (for building the keyed dRPC URL from DRPC_API_KEY).
const DRPC_NETWORK: Record<number, string> = {
  8453: 'base',
  10: 'optimism',
  130: 'unichain',
};

// chainId -> a known keyless ARCHIVE RPC used as the fallback when none is set. The
// sovereign chains (OP 10, Unichain 130) get a keyless default so the settle decoder
// resolves a client with no per-chain env (override with SETTLE_RPC_URL_<id> for a
// keyed endpoint). MUST be archive: the decoder's historical backfill does getLogs on
// old blocks, which publicnode's keyless tier REJECTS ("Archive requests require a
// personal token"). The official OP/Unichain endpoints serve archive getLogs (verified
// on 2000-block windows at the sovereign settlement) keylessly; publicnode stays for
// Base (8453), whose decoder use is tip-only.
const DEFAULT_FALLBACK: Record<number, string> = {
  8453: 'https://base-rpc.publicnode.com',
  10: 'https://mainnet.optimism.io',
  130: 'https://mainnet.unichain.org',
};

const RPC_TIMEOUT_MS = 15_000;

function primaryUrl(chainId: number): string | undefined {
  const explicit = process.env[`SETTLE_RPC_URL_${chainId}`];
  if (explicit) return explicit;
  const key = process.env.DRPC_API_KEY;
  const net = DRPC_NETWORK[chainId];
  if (key && net) return `https://lb.drpc.org/ogrpc?network=${net}&dkey=${key}`;
  return undefined;
}

function fallbackUrl(chainId: number): string | undefined {
  return process.env[`SETTLE_RPC_FALLBACK_${chainId}`] ?? DEFAULT_FALLBACK[chainId];
}

const cache = new Map<number, PublicClient>();

export function getRpcClient(chainId: number): PublicClient {
  const cached = cache.get(chainId);
  if (cached) return cached;

  const urls = [primaryUrl(chainId), fallbackUrl(chainId)].filter((u): u is string => Boolean(u));
  if (urls.length === 0) {
    throw new Error(
      `settle-decoder: no RPC configured for chain ${chainId} (set SETTLE_RPC_URL_${chainId} or DRPC_API_KEY)`,
    );
  }
  const client = createPublicClient({
    transport: fallback(urls.map((u) => http(u, { timeout: RPC_TIMEOUT_MS }))),
  });
  cache.set(chainId, client);
  return client;
}

/** Test seam: drop the cached clients (so env overrides take effect between tests). */
export function _resetRpcClients(): void {
  cache.clear();
}
