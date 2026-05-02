import { fallback, http, type Transport } from 'viem';

const ALCHEMY_KEY = process.env.ALCHEMY_GNOSIS_KEY ?? 'demo';

export const GNOSIS_RPC_URLS = [
  `https://gnosis-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`,
  'https://gnosis.publicnode.com',
  'https://rpc.ankr.com/gnosis',
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
