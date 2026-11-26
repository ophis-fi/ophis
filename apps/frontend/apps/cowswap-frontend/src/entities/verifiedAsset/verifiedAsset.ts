import {
  NATIVE_CURRENCIES,
  STARKNET_CHAIN_ID,
  SUI_CHAIN_ID,
  TRON_CHAIN_ID,
  type CircleTokenIdentity,
  isCircleToken,
} from '@cowprotocol/common-const'
import { AdditionalTargetChainId, getAddressKey, TargetChainId } from '@cowprotocol/cow-sdk'

export const STOCK_LABELS = {
  xStocks: 'xStocks',
  wrappedXStocks: 'Wrapped xStocks',
  ondo: 'Ondo',
  bridgedOndo: 'Bridged Ondo',
  coinbase: 'Coinbase',
  robinhood: 'Robinhood',
  bStocks: 'bStocks',
  reality: 'Reality',
} as const
export type StockIssuer = keyof typeof STOCK_LABELS
export function isStockIssuer(value: Verification | undefined): value is StockIssuer {
  return !!value && Object.prototype.hasOwnProperty.call(STOCK_LABELS, value)
}

type StablecoinIssuer = 'Circle' | 'Tether' | 'Paxos' | 'Ripple Custody & Trust Co.' | 'SG-FORGE'
export type Verification = StockIssuer | 'mismatch' | 'circleSymbol' | 'native' | StablecoinIssuer

export type StockGroup = { issuer: string; chains: number[]; tokens: Record<string, string | undefined> }

const solana = AdditionalTargetChainId.SOLANA
// Direct mainnet deployments only. A bridged representation has a different issuer.
const stablecoins: readonly [number, string, string, StablecoinIssuer][] = [
  // developers.circle.com/stablecoins/{usdc,eurc}-contract-addresses · circle.com/legal/eea-terms
  [solana, 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'USDC', 'Circle'],
  [solana, 'HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr', 'EURC', 'Circle'],
  [SUI_CHAIN_ID, '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC', 'USDC', 'Circle'],
  [STARKNET_CHAIN_ID, '0x033068f6539f8e6e6b131e6b2b814e6c34a5224bc66947c47dab9dfee93b35fb', 'USDC', 'Circle'],
  [130, '0x078d782b760474a361dda0af3839290b0ef57ad6', 'USDC', 'Circle'],
  [143, '0x754704bc059f8c67012fed69bc8a327a5aafb603', 'USDC', 'Circle'],
  [196, '0xb6ceceab302e2e4948951ee7843fc24e92933061', 'USDC', 'Circle'],
  [999, '0xb88339cb7199b77e23db6e890353e22632ba630f', 'USDC', 'Circle'],
  // tether.to/en/supported-protocols · cnad.gob.sv/issuers/ (EME-0003)
  [1, '0xdac17f958d2ee523a2206206994597c13d831ec7', 'USDT', 'Tether'],
  [43114, '0x9702230a8ea53601f5cd2dc00fdbc13d4df4a8c7', 'USDT', 'Tether'],
  [TRON_CHAIN_ID, 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', 'USDT', 'Tether'],
  [solana, 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', 'USDT', 'Tether'],
  // docs.paxos.com/guides/stablecoin/{pyusd,usdg}/mainnet · paxos.com/terms-and-conditions/stablecoin-terms-conditions
  [1, '0x6c3ea9036406852006290770bedfcaba0e23a0e8', 'PYUSD', 'Paxos'],
  [42161, '0x46850ad61c2b7d64d08c9c754f45254596696984', 'PYUSD', 'Paxos'],
  [137, '0x99af3eea856556646c98c8b9b2548fe815240750', 'PYUSD', 'Paxos'],
  [196, '0x87b4a8176b3df6b71e26cc095edcaf4db07506b4', 'PYUSD', 'Paxos'],
  [solana, '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo', 'PYUSD', 'Paxos'],
  [1, '0xe343167631d89b6ffc58b88d6b7fb0228795491d', 'USDG', 'Paxos'],
  [57073, '0xe343167631d89b6ffc58b88d6b7fb0228795491d', 'USDG', 'Paxos'],
  [42161, '0x004b506865409877c9fa29bfb1eba929984b9bbc', 'USDG', 'Paxos'],
  [4663, '0x5fc5360d0400a0fd4f2af552add042d716f1d168', 'USDG', 'Paxos'],
  [196, '0x4ae46a509f6b1d9056937ba4500cb143933d2dc8', 'USDG', 'Paxos'],
  [solana, '2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH', 'USDG', 'Paxos'],
  // Paxos USDP Examination Report, September 2024, token contracts on Ethereum and Solana.
  [1, '0x8e870d67f660d95d5be530380d0ec0bd388289e1', 'USDP', 'Paxos'],
  [solana, 'HVbpJAQGNpkgBaYBZQBR1t7yFdvaYVp2vCQQfKKEN4tM', 'USDP', 'Paxos'],
  // docs.ripple.com/products/stablecoin/overview/token-addresses · ripple.com/legal/stablecoin
  [1, '0x8292bb45bf1ee4d140127049757c2e0ff06317ed', 'RLUSD', 'Ripple Custody & Trust Co.'],
  [8453, '0x8d58c0c60b8d6b88fa98b291a646db34d0f98258', 'RLUSD', 'Ripple Custody & Trust Co.'],
  [57073, '0x8d58c0c60b8d6b88fa98b291a646db34d0f98258', 'RLUSD', 'Ripple Custody & Trust Co.'],
  [10, '0x8d58c0c60b8d6b88fa98b291a646db34d0f98258', 'RLUSD', 'Ripple Custody & Trust Co.'],
  [4663, '0x8d58c0c60b8d6b88fa98b291a646db34d0f98258', 'RLUSD', 'Ripple Custody & Trust Co.'],
  [130, '0x8d58c0c60b8d6b88fa98b291a646db34d0f98258', 'RLUSD', 'Ripple Custody & Trust Co.'],
  // sgforge.com/coinvertible/ · EURCV and USDCV MiCA white papers, issuer contracts.
  [1, '0x5f7827fdeb7c20b443265fc2f40845b715385ff2', 'EURCV', 'SG-FORGE'],
  [solana, 'DghpMkatCiUsofbTmid3M3kAbDTPqDwKiYHnudXeGG52', 'EURCV', 'SG-FORGE'],
  [1, '0x5422374b27757da72d5265cc745ea906e0446634', 'USDCV', 'SG-FORGE'],
  [solana, '8smindLdDuySY6i2bStQX9o8DVhALCXCMbNxD98unx35', 'USDCV', 'SG-FORGE'],
]

function identityKey(chain: number, address: string): string {
  if (chain === solana && address === 'SOL') return NATIVE_CURRENCIES[solana].address
  return chain === STARKNET_CHAIN_ID || /^0x[\da-f]{40}$/i.test(address) ? getAddressKey(address) : address
}

export function stockIssuer(
  stocks: readonly StockGroup[],
  chain: number,
  address: string,
  symbol?: string,
): StockIssuer | 'mismatch' | undefined {
  const key = identityKey(chain, address)
  for (const { issuer, chains, tokens } of stocks) {
    if (!chains.includes(chain) || typeof tokens[key] !== 'string') continue
    return symbol && tokens[key] !== symbol.toUpperCase() ? 'mismatch' : (issuer as StockIssuer)
  }
  return undefined
}

function confirmSymbol(
  symbol: string | undefined,
  expected: (string | undefined)[],
  verification: Verification,
): Verification {
  return !symbol || expected.some((value) => value?.toUpperCase() === symbol.toUpperCase()) ? verification : 'mismatch'
}

export function presetVerification(token: CircleTokenIdentity): Verification | undefined {
  if (isCircleToken(token)) return 'circleSymbol'
  const { chainId: chain, address } = token
  if (!chain || !address) return undefined
  const key = identityKey(chain, address)
  const stablecoin = stablecoins.find(([network, contract]) => network === chain && contract === key)
  if (stablecoin) {
    const [, , symbol, issuer] = stablecoin
    return confirmSymbol(token.symbol, symbol === 'USDT' ? ['USDT', 'USD₮'] : [symbol], issuer)
  }
  const native = NATIVE_CURRENCIES[chain as TargetChainId]
  if (native?.address && identityKey(chain, native.address) === key) {
    return confirmSymbol(token.symbol, [native.symbol], 'native')
  }
  return undefined
}
