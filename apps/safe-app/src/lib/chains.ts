import { OPHIS_ORDERBOOK_URLS } from '@ophis/sdk';

// Gate the chain selector to chains with a live Ophis orderbook host. This mirrors
// buildOphisOrderMetadata's own missing-host guard.
export function isOphisFeeChain(chainId: number): boolean {
  return OPHIS_ORDERBOOK_URLS[chainId] !== undefined;
}
