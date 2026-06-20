import { OPHIS_FEE_CHAIN_IDS } from '@ophis/sdk';

// Gate the chain selector to the chains where the Ophis partner fee is enforced.
// MegaETH/HyperEVM are paused (no live orderbook host) so they must stay excluded
// regardless of any settlement-map presence.
export function isOphisFeeChain(chainId: number): boolean {
  const ids = OPHIS_FEE_CHAIN_IDS as unknown;
  if (ids instanceof Set) return ids.has(chainId);
  if (Array.isArray(ids)) return (ids as number[]).includes(chainId);
  return false;
}
