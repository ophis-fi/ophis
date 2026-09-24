import { type Address, type Hex, parseAbi } from 'viem'

import { cctpNetwork, TOKEN_MESSENGER } from './cctp.const'

export type CctpAsset = 'USDC' | 'EURC' | 'cirBTC'
export const CCTP_ASSETS: readonly CctpAsset[] = ['USDC', 'EURC', 'cirBTC']
export const CROSS_CHAIN_TOKEN_SERVICE: Address = '0x431871229103b780868f8C6BB820cd16ECf942BC'

// Native issuer tokens only. Circle registry and onchain resolution verified 2026-09-24.
const expandedAssets: Record<
  Exclude<CctpAsset, 'USDC'>,
  {
    tokenId: Hex
    manager: Address
    decimals: number
    addresses: Partial<Record<number, Address>>
  }
> = {
  EURC: {
    tokenId: '0x6ca9e29fa53becc29becaf4a90b9ca7a995ad4d2234880da13ca38c657fb241c',
    manager: '0x8c27579e24f9f19d96724e19fc059dacd1469e10',
    decimals: 6,
    addresses: {
      1: '0x1abaea1f7c830bd89acc67ec4af516284b1bc33c',
      8453: '0x60a3e35cc302bfa44cb288bc5a4f316fdb1adb42',
      5042: '0xbef5f6d51cb62b58e6a8f77868681825c6fe21c1',
    },
  },
  cirBTC: {
    tokenId: '0x3d26699fb5d40190fc3fa0dcbc1cd24e558355043c1997572ff9fd6efbb3fdca',
    manager: '0xa1db0fda2d1bfebe2e5701fe73b252bc2b25700e',
    decimals: 8,
    addresses: {
      1: '0x72dfb2e44f59c5ad2bafe84314e5b99a7cd5075e',
      5042: '0x171a4217b86a807a64eb94757db6849fb4bdbaa0',
    },
  },
}

export function cctpAsset(asset: CctpAsset = 'USDC'): {
  symbol: CctpAsset
  decimals: number
  tokenId?: Hex
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
  return asset === 'USDC' || !!expandedAssets[asset].addresses[chainId]
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
