import {
  HYPERCORE_CHAIN_ID,
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

type Preset =
  | 'native'
  | 'wrappedSol'
  | 'circle'
  | 'tether'
  | 'usdt0'
  | 'binancePegUsdc'
  | 'binancePegUsdt'
  | 'bridgedUsdc'
  | 'bridgedUsdt'
const presetSymbols: Record<Preset, string[]> = {
  native: ['SOL'],
  wrappedSol: ['WSOL', 'SOL'],
  circle: ['USDC'],
  tether: ['USDT', 'USD₮'],
  usdt0: ['USDT0', 'USDT'],
  binancePegUsdc: ['USDC'],
  binancePegUsdt: ['USDT'],
  bridgedUsdc: ['USDC.E', 'USDBC'],
  bridgedUsdt: ['USDT'],
}
export type Verification = StockIssuer | 'mismatch' | 'circleSymbol' | Preset

export type StockGroup = { issuer: string; chains: number[]; tokens: Record<string, string | undefined> }

const solana = AdditionalTargetChainId.SOLANA
// Issuer mainnet records: developers.circle.com/stablecoins/usdc-contract-addresses,
// tether.to/en/supported-protocols and docs.usdt0.to/technical-documentation/deployments.
const presetAssets: [number, string, Preset][] = [
  [solana, 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'circle'],
  [solana, 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', 'tether'],
  [solana, 'So11111111111111111111111111111111111111112', 'wrappedSol'],
  [solana, 'SOL', 'native'],
  [1, '0xdac17f958d2ee523a2206206994597c13d831ec7', 'tether'],
  [43114, '0x9702230a8ea53601f5cd2dc00fdbc13d4df4a8c7', 'tether'],
  [TRON_CHAIN_ID, 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', 'tether'],
  [SUI_CHAIN_ID, '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC', 'circle'],
  [STARKNET_CHAIN_ID, '0x033068f6539f8e6e6b131e6b2b814e6c34a5224bc66947c47dab9dfee93b35fb', 'circle'],
  [130, '0x078d782b760474a361dda0af3839290b0ef57ad6', 'circle'],
  [143, '0x754704bc059f8c67012fed69bc8a327a5aafb603', 'circle'],
  [196, '0xb6ceceab302e2e4948951ee7843fc24e92933061', 'circle'],
  [999, '0xb88339cb7199b77e23db6e890353e22632ba630f', 'circle'],
  // https://www.binance.com/en/skills/detail/binance-web3/binance-agentic-wallet
  [56, '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d', 'binancePegUsdc'],
  [56, '0x55d398326f99059ff775485246999027b3197955', 'binancePegUsdt'],
  // Optimism's Superchain Token List: https://static.optimism.io/optimism.tokenlist.json
  [10, '0x7f5c764cbc14f9669b88837ca1490cca17c31607', 'bridgedUsdc'],
  [8453, '0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca', 'bridgedUsdc'],
  [10, '0x94b008aa00579c1307b0ef2c499ad98a8ce58e58', 'bridgedUsdt'],
  [8453, '0xfde4c96c8593536e31f229ea8f37b2ada2699bb2', 'bridgedUsdt'],
  [10, '0x01bff41798a0bcf287b996046ca68b395dbc1071', 'usdt0'],
  [137, '0xc2132d05d31c914a87c6611c10748aeb04b58e8f', 'usdt0'],
  [143, '0xe7cd86e13ac4309349f30b3435a9d337750fc82d', 'usdt0'],
  [196, '0x779ded0c9e1022225f8e0630b35a9b54be713736', 'usdt0'],
  [999, '0xb8ce59fc3717ada4c02eadf9682a9e934f625ebb', 'usdt0'],
  [9745, '0xb8ce59fc3717ada4c02eadf9682a9e934f625ebb', 'usdt0'],
  [42161, '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9', 'usdt0'],
  [57073, '0x0200c29006150606b650577bbe7b6248f58470c1', 'usdt0'],
  [HYPERCORE_CHAIN_ID, '0x25faedc3f054130dbb4e4203aca63567', 'usdt0'],
]

function identityKey(chain: number, address: string): string {
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

function confirmSymbol(symbol: string | undefined, expected: string[], verification: Verification): Verification {
  return !symbol || expected.includes(symbol.toUpperCase()) ? verification : 'mismatch'
}

export function presetVerification(token: CircleTokenIdentity): Verification | undefined {
  if (isCircleToken(token)) return 'circleSymbol'
  const { chainId: chain, address } = token
  if (!chain || !address) return undefined
  const key = identityKey(chain, address)
  const preset = presetAssets.find(([network, contract]) => network === chain && contract === key)
  if (preset) {
    return confirmSymbol(token.symbol, presetSymbols[preset[2]], preset[2])
  }
  const native = NATIVE_CURRENCIES[chain as TargetChainId]
  if (native?.address && identityKey(chain, native.address) === key) {
    return confirmSymbol(token.symbol, [native.symbol?.toUpperCase() ?? ''], 'native')
  }
  return undefined
}
