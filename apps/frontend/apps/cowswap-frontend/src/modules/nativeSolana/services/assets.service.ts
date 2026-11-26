import type { CircleTokenIdentity } from '@cowprotocol/common-const'
import { fetchWithTimeout } from '@cowprotocol/common-utils'
import { AdditionalTargetChainId } from '@cowprotocol/cow-sdk'

import {
  OPHIS_LOCAL_WALLET_RPC,
  SOLANA_NATIVE_ASSET,
  WRAPPED_SOL_MINT,
  solanaAddress,
  type OphisWalletHolding,
} from '@ophis/solana-sdk'
import {
  OPHIS_SOLANA_CONFIG,
  OPHIS_SOLANA_MAINNET_API,
  SOLANA_DEVNET_GENESIS,
  type OphisSolanaConfig,
} from 'entities/solana'
import { z } from 'zod'

export const walletHoldingsKey = (genesis?: string, owner?: string) => ['solana-wallet-assets', genesis, owner] as const

export interface SolanaAsset {
  mint: string
  symbol: string
  symbolIsPlaceholder?: true
  name: string
  decimals?: number
  icon?: string
}

export const isSolanaMainnet = OPHIS_SOLANA_CONFIG?.chain === 'solana:mainnet'

export function solanaAssetIdentity(asset: SolanaAsset | null): CircleTokenIdentity {
  const chainId = isSolanaMainnet ? AdditionalTargetChainId.SOLANA : undefined
  return { chainId, address: asset?.mint, symbol: asset?.symbolIsPlaceholder ? undefined : asset?.symbol }
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
  {
    mint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
    symbol: 'JUP',
    name: 'Jupiter',
    decimals: 6,
    icon: '/logos/token-jup.svg',
  },
  {
    mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
    symbol: 'BONK',
    name: 'Bonk',
    decimals: 5,
    icon: '/logos/token-bonk.png',
  },
  { mint: 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn', symbol: 'JitoSOL', name: 'Jito Staked SOL', decimals: 9 },
]

export function shortMint(value: string): string {
  return value.length > 14 ? value.slice(0, 5) + '…' + value.slice(-5) : value
}
export function unknownAsset(mint: string): SolanaAsset {
  return { mint, symbol: shortMint(mint), symbolIsPlaceholder: true, name: 'SPL token' }
}
export function walletMint(mint: string): string {
  return mint === SOLANA_NATIVE_ASSET ? 'SOL' : mint
}
export function mainnetWalletRpc(config: OphisSolanaConfig | null): string | undefined {
  if (config?.chain !== 'solana:mainnet') return undefined
  const api = config.api.replace(/\/$/, '')
  if (api === OPHIS_SOLANA_MAINNET_API || api === window.location.origin + '/solana-api') {
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

const catalogLabel = z
  .string()
  .trim()
  .min(1)
  .regex(/^[^\p{Cc}\p{Bidi_Control}]+$/u)
const catalogToken = z.object({
  chainId: z.literal(101).nullish(),
  address: z.string().min(32).max(44),
  name: catalogLabel.max(128),
  symbol: catalogLabel.max(64),
  decimals: z.number().int().min(0).max(255),
  logoURI: z.string().optional().catch(undefined),
})

export async function fetchMainnetCatalog(): Promise<SolanaAsset[]> {
  const response = await fetchWithTimeout('https://tokens.coingecko.com/solana/all.json', {
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
    timeout: 15_000,
  })
  if (!response.ok) throw Error('Solana token list unavailable.')
  const { tokens } = z.object({ tokens: z.array(z.unknown()) }).parse(await response.json())
  const assets: SolanaAsset[] = []
  for (const entry of tokens) {
    const result = catalogToken.safeParse(entry)
    if (!result.success || result.data.address === SOLANA_NATIVE_ASSET) continue
    const token = result.data
    try {
      assets.push({
        mint: solanaAddress(token.address),
        name: token.name,
        symbol: token.symbol,
        decimals: token.decimals,
        icon: token.logoURI?.startsWith('https://assets.coingecko.com/coins/images/') ? token.logoURI : undefined,
      })
    } catch {
      // A malformed listing must not hide the rest of the catalog.
    }
  }
  if (!assets.length) throw Error('Empty Solana token list.')
  return assets
}

export function walletAssets(
  network: SolanaAsset[],
  holdings: readonly OphisWalletHolding[],
  catalog: readonly SolanaAsset[] = [],
): SolanaAsset[] {
  const assets = new Map(network.map((asset) => [asset.mint, asset]))
  for (const asset of catalog) {
    const existing = assets.get(asset.mint)
    if (!existing) assets.set(asset.mint, asset)
    else if (!existing.icon && asset.icon) assets.set(asset.mint, { ...existing, icon: asset.icon })
  }
  for (const { mint, name, symbol, decimals } of holdings) {
    const id = walletMint(mint)
    const asset = assets.get(id)
    assets.set(id, {
      ...(asset ?? (symbol ? { mint: id, name: name || 'SPL token', symbol } : unknownAsset(id))),
      decimals,
    })
  }
  return [...assets.values()]
}
