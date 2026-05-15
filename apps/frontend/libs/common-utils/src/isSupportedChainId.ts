import { SupportedChainId } from '@cowprotocol/cow-sdk'

// Ophis fork: Optimism (10), MegaETH (4326), and HyperEVM (999) are treated as
// primary supported chains at the frontend layer, even though the SDK doesn't
// expose them as SupportedChainId entries (OP is AdditionalTargetChainId;
// MegaETH and HyperEVM are absent).
const OPHIS_EXTRA_CHAINS = new Set<number>([10, 4326, 999])

export function isSupportedChainId(chainId: number | undefined): chainId is SupportedChainId {
  return typeof chainId === 'number' && (chainId in SupportedChainId || OPHIS_EXTRA_CHAINS.has(chainId))
}
