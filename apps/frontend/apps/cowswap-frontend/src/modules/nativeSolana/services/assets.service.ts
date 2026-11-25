import {
  OPHIS_LOCAL_WALLET_RPC,
  SOLANA_NATIVE_ASSET,
  WRAPPED_SOL_MINT,
  solanaAddress,
  type OphisWalletHolding,
} from '@ophis/solana-sdk'
import { SOLANA_DEVNET_GENESIS, type OphisSolanaConfig } from 'entities/solana'

export interface SolanaAsset {
  mint: string
  symbol: string
  name: string
  decimals?: number
  icon?: string
}
export const nativeAsset: SolanaAsset = {
  mint: 'SOL',
  symbol: 'SOL',
  name: 'Solana',
  decimals: 9,
  icon: '/logos/token-sol.svg',
}
const mainnetAssets: SolanaAsset[] = [
  {
    mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    symbol: 'USDC',
    decimals: 6,
    name: 'USD Coin',
    icon: '/logos/token-usdc.png',
  },
  {
    mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
    symbol: 'USDT',
    decimals: 6,
    name: 'Tether USD',
    icon: '/logos/token-usdt.png',
  },
  { mint: WRAPPED_SOL_MINT, symbol: 'wSOL', name: 'Wrapped SOL', decimals: 9, icon: '/logos/token-sol.svg' },
]

export function shortMint(value: string): string {
  return value.length > 14 ? value.slice(0, 5) + '…' + value.slice(-5) : value
}
export function unknownAsset(mint: string): SolanaAsset {
  return { mint, symbol: shortMint(mint), name: 'SPL token' }
}
export function walletMint(mint: string): string {
  return mint === SOLANA_NATIVE_ASSET ? 'SOL' : mint
}
export function mainnetWalletRpc(config: OphisSolanaConfig | null): string | undefined {
  if (config?.chain !== 'solana:mainnet') return undefined
  const api = config.api.replace(/\/$/, '')
  if (api === 'https://solana-mainnet.ophis.fi/solana-api' || api === window.location.origin + '/solana-api') {
    return api + '/wallet-rpc'
  }
  return undefined
}

export function balanceEndpoint(config: OphisSolanaConfig | null): string | undefined {
  switch (config?.chain) {
    case 'solana:localnet':
      return ['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname) ? OPHIS_LOCAL_WALLET_RPC : undefined
    case 'solana:mainnet':
      return mainnetWalletRpc(config) ?? 'https://api.mainnet-beta.solana.com'
    case 'solana:devnet':
      return 'https://api.devnet.solana.com'
    case 'solana:testnet':
      return 'https://api.testnet.solana.com'
    default:
      return undefined
  }
}

export async function networkAssets(config: OphisSolanaConfig | null): Promise<SolanaAsset[]> {
  if (config?.chain === 'solana:mainnet') return [nativeAsset, ...mainnetAssets]
  if (config?.chain === 'solana:devnet' && config.genesis === SOLANA_DEVNET_GENESIS)
    return [
      nativeAsset,
      { mint: 'BRjpCHtyQLNCo8gqRUr8jtdAj5AjPYQaoqbvcZiHok1k', symbol: 'devUSDC', name: 'Orca devnet test USDC' },
    ]
  if (config?.chain === 'solana:localnet' && balanceEndpoint(config)) return localPreviewAssets(config.genesis)
  return [nativeAsset]
}

async function localPreviewAssets(genesis: string): Promise<SolanaAsset[]> {
  const response = await fetch('/solana-preview-market.txt', { cache: 'no-store' })
  if (response.ok && response.headers.get('content-type')?.includes('text/plain')) {
    const fixture = await response.json()
    if (fixture.genesis === genesis) {
      return [nativeAsset, { mint: solanaAddress(fixture.buyMint), name: 'Ophis test token', symbol: 'TEST' }]
    }
  }
  return [nativeAsset]
}

export function walletAssets(network: SolanaAsset[], holdings: readonly OphisWalletHolding[]): SolanaAsset[] {
  const assets = new Map(network.map((asset) => [asset.mint, asset]))
  for (const { mint, name, symbol, decimals } of holdings) {
    const id = walletMint(mint)
    const asset = assets.get(id)
    if (asset?.decimals !== undefined) continue
    assets.set(id, { ...(asset ?? (name && symbol ? { mint: id, name, symbol } : unknownAsset(id))), decimals })
  }
  return [...assets.values()]
}
