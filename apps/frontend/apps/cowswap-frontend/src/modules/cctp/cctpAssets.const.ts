import { type Address, type Hex, maxUint256, parseAbi } from 'viem'

import { CCTP_NETWORKS, cctpNetwork, TOKEN_MESSENGER, MAX_BURN } from './cctp.const'
import { CCTPX_ASSETS } from './cctpxAssets.const'

export type CctpAsset = 'USDC' | keyof typeof CCTPX_ASSETS
export const CCTP_ASSETS: readonly CctpAsset[] = [
  'USDC',
  'EURC',
  'cirBTC',
  'WETH',
  ...(Object.keys(CCTPX_ASSETS).filter(
    (asset) => !['EURC', 'cirBTC', 'WETH'].includes(asset),
  ) as (keyof typeof CCTPX_ASSETS)[]),
]
export const CROSS_CHAIN_TOKEN_SERVICE: Address = '0x431871229103b780868f8C6BB820cd16ECf942BC'
const expandedAssets: Record<
  Exclude<CctpAsset, 'USDC'>,
  {
    homeChainId?: number
    tokenId: Hex
    manager: Address
    decimals: number
    addresses: Partial<Record<number, Address>>
  }
> = CCTPX_ASSETS

export function isCctpAsset(asset: unknown): asset is CctpAsset {
  return typeof asset === 'string' && CCTP_ASSETS.some((item) => item === asset)
}

export function cctpMaxAmount(asset: CctpAsset = 'USDC'): bigint {
  // Preserve the original launch limits and legacy journals. Other assets use
  // uint256 units; the token manager enforces its own token-specific limits.
  return asset === 'USDC' || asset === 'EURC' || asset === 'cirBTC' ? MAX_BURN : maxUint256
}

export function cctpAsset(asset: CctpAsset = 'USDC'): {
  symbol: CctpAsset
  decimals: number
  tokenId?: Hex
  homeChainId?: number
} {
  return asset === 'USDC' ? { symbol: asset, decimals: 6 } : { symbol: asset, ...expandedAssets[asset] }
}

export function cctpToken(chainId: number, asset: CctpAsset = 'USDC'): Address {
  if (asset === 'USDC') return cctpNetwork(chainId).usdc
  const address = expandedAssets[asset].addresses[chainId]
  if (!address) throw new Error('This asset is not supported on the selected network')
  return address
}

export function supportsCctpAsset(chainId: number, asset: CctpAsset): boolean {
  return (
    CCTP_NETWORKS.some(({ chain }) => chain.id === chainId) &&
    (asset === 'USDC' || !!expandedAssets[asset].addresses[chainId])
  )
}

export function cctpSpender(asset: CctpAsset = 'USDC'): Address {
  return asset === 'USDC' ? TOKEN_MESSENGER : expandedAssets[asset].manager
}

export function cctpService(asset: CctpAsset = 'USDC'): Address {
  return asset === 'USDC' ? TOKEN_MESSENGER : CROSS_CHAIN_TOKEN_SERVICE
}

export const CCTPX_ABI = parseAbi([
  'function crossChainTransfer(bytes32 tokenId,uint256 amount,uint32 destinationDomain,bytes destinationAddress,bytes32 destinationCaller,uint32 minFinalityThreshold,(bytes signedQuote,address refundAddress) claim,bool autoExecuteHookData,bytes hookData) payable',
  'function resolveTokenAddress(bytes32 tokenId) view returns(address)',
  'function resolveTokenManager(bytes32 tokenId) view returns(address)',
  'function isTrustedDomain(uint32 domain) view returns(bool)',
])

export function cctpAssetRoute(
  asset: CctpAsset,
  source: number,
  destination: number,
): { source: number; destination: number } {
  const networks = CCTP_NETWORKS.filter(({ chain }) => supportsCctpAsset(chain.id, asset))
  const nextSource = supportsCctpAsset(source, asset)
    ? source
    : networks.find(({ chain }) => chain.id !== destination)?.chain.id
  const nextDestination =
    supportsCctpAsset(destination, asset) && destination !== nextSource
      ? destination
      : networks.find(({ chain }) => chain.id !== nextSource)?.chain.id
  if (nextSource === undefined || nextDestination === undefined) throw new Error('No bridge route for this asset')
  return { source: nextSource, destination: nextDestination }
}
