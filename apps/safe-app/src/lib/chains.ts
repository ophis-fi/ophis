import { OPHIS_ORDERBOOK_URLS } from '@ophis/sdk';

// Gate the chain selector to chains with a LIVE Ophis orderbook host. The fee-chain set
// (OPHIS_FEE_CHAIN_IDS) is wider: it includes the Ophis-operated chains whose orderbook is
// currently PAUSED (MegaETH 4326, HyperEVM 999) — those have a deployed settlement + fee config
// but no live host, so an order there is accepted by metadata but can never be submitted. Gating
// on OPHIS_ORDERBOOK_URLS (the live-host map, which omits 4326/999) is the correct admission test.
// This mirrors buildOphisOrderMetadata's own `OPHIS_ORDERBOOK_URLS[chainId] === undefined` guard.
export function isOphisFeeChain(chainId: number): boolean {
  return OPHIS_ORDERBOOK_URLS[chainId] !== undefined;
}
