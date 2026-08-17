import { SupportedChainId } from '@cowprotocol/cow-sdk'

/**
 * Maps chain names used in URL query parameters to SupportedChainId
 * Those networks are the ones that existed before we started using chain IDs in the URL
 */
const chainNameToIdMap: { [key: string]: SupportedChainId } = {
  mainnet: SupportedChainId.MAINNET,
  gnosis_chain: SupportedChainId.GNOSIS_CHAIN,
  sepolia: SupportedChainId.SEPOLIA,
}

export function getCurrentChainIdFromUrl(location = window.location): SupportedChainId {
  return getRawCurrentChainIdFromUrl(location) || SupportedChainId.MAINNET
}

// Trying to get chainId from URL (#/100/swap)
export function getRawCurrentChainIdFromUrl(location = window.location): SupportedChainId | null {
  const chainId = readChainIdFromHash(location.hash)

  // Ophis fork: chains 10 (Optimism), 130 (Unichain), and 4663 (Robinhood)
  // are supported at frontend
  // layer even though the SDK enum doesn't include them as primary SupportedChainId.
  if (chainId && (chainId in SupportedChainId || chainId === 10 || chainId === 130 || chainId === 4663))
    return chainId as SupportedChainId

  return null
}

function readChainIdFromHash(hash: string): number {
  const pathMatch = hash.match(/^#\/(\d{1,9})\D/)
  if (pathMatch) return Number(pathMatch[1])

  const chainName = new URLSearchParams(hash.split('?')[1]).get('chain')
  return chainName ? chainNameToIdMap[chainName] || 0 : 0
}
