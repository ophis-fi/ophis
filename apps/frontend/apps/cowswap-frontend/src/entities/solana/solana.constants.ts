import { solanaAddress, type OphisSolanaWalletChain } from '@ophis/solana-sdk'

export const SOLANA_MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'
export const SOLANA_DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG'

const walletConnectClusters: Readonly<Partial<Record<OphisSolanaWalletChain, string>>> = {
  'solana:mainnet': SOLANA_MAINNET_GENESIS,
  'solana:devnet': SOLANA_DEVNET_GENESIS,
  'solana:testnet': '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY',
}

export type SolanaWalletNetwork = Pick<OphisSolanaConfig, 'chain' | 'genesis'>

export function solanaPairingChain(config: SolanaWalletNetwork | null): string | undefined {
  if (config && walletConnectClusters[config.chain] === config.genesis) return 'solana:' + config.genesis.slice(0, 32)
  return undefined
}

export interface OphisSolanaConfig {
  api: string
  program: ReturnType<typeof solanaAddress>
  genesis: string
  chain: OphisSolanaWalletChain
}

function isPublicApi(url: URL): boolean {
  if ([url.username, url.password, url.search, url.hash].some(Boolean)) return false
  return (
    url.protocol === 'https:' ||
    (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
  )
}

function isExpectedChain(chain: string, genesis: string): boolean {
  return chain === 'solana:mainnet'
    ? genesis === SOLANA_MAINNET_GENESIS
    : chain.startsWith('solana:') && genesis !== SOLANA_MAINNET_GENESIS
}

export function readOphisSolanaConfig(): OphisSolanaConfig | null {
  const api = process.env.REACT_APP_OPHIS_SOLANA_API
  const program = process.env.REACT_APP_OPHIS_SOLANA_PROGRAM
  if (!api || !program) return null
  try {
    const url = new URL(api)
    const chain = process.env.REACT_APP_OPHIS_SOLANA_WALLET_CHAIN || 'solana:mainnet'
    const genesis = process.env.REACT_APP_OPHIS_SOLANA_GENESIS || SOLANA_MAINNET_GENESIS
    if (!isPublicApi(url) || !isExpectedChain(chain, genesis)) return null
    solanaAddress(genesis)
    return { api: url.toString(), program: solanaAddress(program), genesis, chain: chain as OphisSolanaWalletChain }
  } catch {
    return null
  }
}

export const OPHIS_SOLANA_CONFIG = readOphisSolanaConfig()
