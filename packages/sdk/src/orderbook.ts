import { assertValidChainId } from './guards.js';

/**
 * Orderbook base URLs by chainId. MUST stay in sync with the frontend map in
 * apps/frontend/apps/cowswap-frontend/src/cowSdk.ts (`OPHIS_ORDERBOOK_BASE_URLS`).
 *
 * IMPORTANT: Optimism (10) is the one chain that does NOT follow the
 * `api.cow.fi/<slug>` pattern — Ophis self-hosts its OP orderbook. Posting an
 * OP order to `api.cow.fi/optimism-mainnet` (a host that does not serve Ophis)
 * silently bypasses the Ophis solver and the Ophis partner fee. Always resolve
 * the host through `getOphisOrderbookUrl` rather than assembling it by slug.
 */
export const OPHIS_ORDERBOOK_URLS: Readonly<Partial<Record<number, string>>> = Object.freeze({
  1: 'https://api.cow.fi/mainnet',
  100: 'https://api.cow.fi/xdai', // Gnosis Chain — slug is "xdai", not "gnosis"
  42161: 'https://api.cow.fi/arbitrum_one',
  8453: 'https://api.cow.fi/base',
  137: 'https://api.cow.fi/polygon',
  43114: 'https://api.cow.fi/avalanche',
  56: 'https://api.cow.fi/bnb',
  59144: 'https://api.cow.fi/linea',
  9745: 'https://api.cow.fi/plasma',
  57073: 'https://api.cow.fi/ink',
  11155111: 'https://api.cow.fi/sepolia',
  10: 'https://optimism-mainnet.ophis.fi', // Ophis self-hosted OP orderbook (verified live)
});

/**
 * Returns the orderbook base URL for a chain. Throws on an invalid chainId
 * (so "forgot the arg" fails loud) and on a chain Ophis does not route (so an
 * agent never falls back to a wrong/guessed host).
 */
export const getOphisOrderbookUrl = (chainId: number): string => {
  assertValidChainId(chainId);
  const url = OPHIS_ORDERBOOK_URLS[chainId];
  if (!url) {
    throw new Error(
      `Ophis: no orderbook URL for chainId ${chainId}. Supported: ${Object.keys(OPHIS_ORDERBOOK_URLS).join(', ')}.`,
    );
  }
  return url;
};
