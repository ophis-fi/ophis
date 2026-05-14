import { SupportedChainId } from '@cowprotocol/cow-sdk'

// Ophis fork: Optimism (10) is treated as a primary supported chain at the frontend layer,
// even though the SDK exposes it via AdditionalTargetChainId.
const OPHIS_EXTRA_CHAINS = new Set<number>([10])

export function isSupportedChainId(chainId: number | undefined): chainId is SupportedChainId {
  return typeof chainId === 'number' && (chainId in SupportedChainId || OPHIS_EXTRA_CHAINS.has(chainId))
}
