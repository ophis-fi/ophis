import { fallback, http, type Transport } from 'viem';

// Public, no-quota endpoints. Free for everyone, no API key required.
// Alchemy was previously the first-choice URL, but burning Clement's
// shared 300M-CU/month free tier on incidental Gnosis reads risked
// blocking the whole organisation (we hit 90% on 2026-05-13 just from
// the OP Sepolia chain stack). Keeping Alchemy off the default path
// avoids that footgun.
//
// To opt in to Alchemy (paid plan, dedicated key), set both
// `ALCHEMY_GNOSIS_KEY` AND `OPHIS_RPC_USE_ALCHEMY=1` env vars. The
// double-gate is intentional — accidentally setting just the key
// shouldn't change traffic routing.
const ALCHEMY_KEY = process.env.ALCHEMY_GNOSIS_KEY;
const USE_ALCHEMY =
  process.env.OPHIS_RPC_USE_ALCHEMY === '1' && Boolean(ALCHEMY_KEY);

export const GNOSIS_RPC_URLS = [
  'https://gnosis.publicnode.com',
  'https://rpc.ankr.com/gnosis',
  'https://gnosis-rpc.publicnode.com',
  ...(USE_ALCHEMY
    ? [`https://gnosis-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`]
    : []),
] as const;

export interface GnosisFallbackOptions {
  /** If true, viem ranks transports by latency. Defaults to false (strict order). */
  rank?: boolean;
  /** Per-transport retry count. Default 1. */
  retryCount?: number;
}

export const gnosisFallbackTransport = (opts: GnosisFallbackOptions = {}): Transport =>
  fallback(
    GNOSIS_RPC_URLS.map((url) => http(url, { retryCount: opts.retryCount ?? 1 })),
    { rank: opts.rank ?? false },
  );
