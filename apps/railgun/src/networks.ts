import { NetworkName } from '@railgun-community/shared-models'

export type TokenSymbol = 'USDC' | 'USDT' | 'WETH' | 'WPOL' | 'WBNB'
export interface PrivateToken { address: string; decimals: number; symbol: TokenSymbol; bridged?: boolean }

// Router V2 pins: github.com/Uniswap/universal-router/tree/main/deploy-addresses.
// Stablecoins mirror Ophis's existing token catalogue; decimals are verified on each chain.
export const PRIVATE_NETWORKS = [
  {
    chainId: 1, name: 'Ethereum', network: NetworkName.Ethereum, nativeSymbol: 'ETH', wrappedSymbol: 'WETH' as const,
    router: '0x66a9893cc07d91d95644aedd05d03f95e1dba8af',
    quoter: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
    factory: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
    stables: [
      { symbol: 'USDC' as const, address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6 },
      { symbol: 'USDT' as const, address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', decimals: 6 },
    ],
  },
  {
    chainId: 42161, name: 'Arbitrum', network: NetworkName.Arbitrum, nativeSymbol: 'ETH', wrappedSymbol: 'WETH' as const,
    router: '0xa51afafe0263b40edaef0df8781ea9aa03e381a3',
    quoter: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
    factory: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
    stables: [
      { symbol: 'USDC' as const, address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', decimals: 6 },
      { symbol: 'USDT' as const, address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', decimals: 6 },
    ],
  },
  {
    chainId: 137, name: 'Polygon', network: NetworkName.Polygon, nativeSymbol: 'POL', wrappedSymbol: 'WPOL' as const,
    router: '0x1095692a6237d83c6a72f3f5efedb9a670c49223',
    quoter: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
    factory: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
    stables: [
      { symbol: 'USDC' as const, address: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', decimals: 6 },
      { symbol: 'USDT' as const, address: '0xc2132d05d31c914a87c6611c10748aeb04b58e8f', decimals: 6, bridged: true },
    ],
  },
  {
    chainId: 56, name: 'BNB Chain', network: NetworkName.BNBChain, nativeSymbol: 'BNB', wrappedSymbol: 'WBNB' as const,
    router: '0x1906c1d672b88cd1b9ac7593301ca990f94eae07',
    quoter: '0x78D78E420Da98ad378D7799bE8f4AF69033EB077',
    factory: '0xdB1d10011AD0Ff90774D0C6Bb92e5C5c8b4461F7',
    stables: [
      { symbol: 'USDC' as const, address: '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d', decimals: 18, bridged: true },
      { symbol: 'USDT' as const, address: '0x55d398326f99059ff775485246999027b3197955', decimals: 18, bridged: true },
    ],
  },
] as const

export function privateNetwork(chainId: number) {
  const network = PRIVATE_NETWORKS.find((entry) => entry.chainId === chainId)
  if (!network) throw new Error('Private swaps support Ethereum, Arbitrum, Polygon and BNB Chain.')
  return network
}
