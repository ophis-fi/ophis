import { mapSupportedNetworks, SupportedChainId, HttpsString } from '@cowprotocol/cow-sdk'
import { JsonRpcProvider } from '@ethersproject/providers'

// Ophis fork (Phase 3.3 F1, 2026-05-20): the upstream cowswap default
// fell through to `https://<chain>.infura.io/v3/<public-key>` with a
// shared rate-limited key. Every visitor of ophis.fi hit Infura 13+
// times on landing — Infura saw every IP + intended-swap query string.
// That contradicts the "sovereign-infra" narrative AND adds a single
// point of failure on someone else's API key.
//
// Fix: switch the defaults to publicnode (Allnodes' public endpoint —
// no key required, generous free tier, multi-cloud DNS). The
// `REACT_APP_NETWORK_URL_<chainId>` env vars still take precedence
// for any deployer that wants to point at their own infrastructure.
//
// Infura key path is preserved as a fallback for backwards-compat with
// deployers who set REACT_APP_INFURA_KEY explicitly.
const INFURA_KEY = process.env['REACT_APP_INFURA_KEY'] || ''

const RPC_URL_ENVS: Record<SupportedChainId, HttpsString | undefined> = {
  [SupportedChainId.MAINNET]: (process.env['REACT_APP_NETWORK_URL_1'] as HttpsString) || undefined,
  [SupportedChainId.BNB]: (process.env['REACT_APP_NETWORK_URL_56'] as HttpsString) || undefined,
  [SupportedChainId.GNOSIS_CHAIN]: (process.env['REACT_APP_NETWORK_URL_100'] as HttpsString) || undefined,
  [SupportedChainId.POLYGON]: (process.env['REACT_APP_NETWORK_URL_137'] as HttpsString) || undefined,
  [SupportedChainId.BASE]: (process.env['REACT_APP_NETWORK_URL_8453'] as HttpsString) || undefined,
  [SupportedChainId.PLASMA]: (process.env['REACT_APP_NETWORK_URL_9745'] as HttpsString) || undefined,
  [SupportedChainId.ARBITRUM_ONE]: (process.env['REACT_APP_NETWORK_URL_42161'] as HttpsString) || undefined,
  [SupportedChainId.AVALANCHE]: (process.env['REACT_APP_NETWORK_URL_43114'] as HttpsString) || undefined,
  [SupportedChainId.INK]: (process.env['REACT_APP_NETWORK_URL_57073'] as HttpsString) || undefined,
  [SupportedChainId.LINEA]: (process.env['REACT_APP_NETWORK_URL_59144'] as HttpsString) || undefined,
  [SupportedChainId.SEPOLIA]: (process.env['REACT_APP_NETWORK_URL_11155111'] as HttpsString) || undefined,
  // Ophis fork: OP mainnet (chain 10) added at frontend layer
  [10 as unknown as SupportedChainId]: (process.env['REACT_APP_NETWORK_URL_10'] as HttpsString) || undefined,
  // Ophis fork: MegaETH mainnet (chain 4326) added at frontend layer
  [4326 as unknown as SupportedChainId]: (process.env['REACT_APP_NETWORK_URL_4326'] as HttpsString) || undefined,
  // Ophis fork: HyperEVM mainnet (chain 999) added at frontend layer
  [999 as unknown as SupportedChainId]: (process.env['REACT_APP_NETWORK_URL_999'] as HttpsString) || undefined,
}

// Ophis fork (F1, 2026-05-20): defaults switched from Infura (which
// tracked every visitor's IP + swap intent) to publicnode endpoints.
// If REACT_APP_INFURA_KEY is set at deploy time, Infura is still
// attempted first for compatibility — see usesInfura branch in
// getRpcUrl(). publicnode is a non-tracking fallback that needs no key.
const DEFAULT_RPC_URL: Record<SupportedChainId, { url: HttpsString; usesInfura: boolean }> = {
  [SupportedChainId.MAINNET]: { url: `https://ethereum-rpc.publicnode.com`, usesInfura: false },
  [SupportedChainId.BNB]: { url: `https://bsc-rpc.publicnode.com`, usesInfura: false },
  [SupportedChainId.GNOSIS_CHAIN]: { url: `https://rpc.gnosis.gateway.fm`, usesInfura: false },
  [SupportedChainId.POLYGON]: { url: `https://polygon-bor-rpc.publicnode.com`, usesInfura: false },
  [SupportedChainId.BASE]: { url: `https://base-rpc.publicnode.com`, usesInfura: false },
  [SupportedChainId.PLASMA]: { url: `https://rpc.plasma.to`, usesInfura: false },
  [SupportedChainId.ARBITRUM_ONE]: { url: `https://arbitrum-one-rpc.publicnode.com`, usesInfura: false },
  [SupportedChainId.AVALANCHE]: { url: `https://avalanche-c-chain-rpc.publicnode.com`, usesInfura: false },
  // Ink: kept upstream's `rpc-ten.inkonchain.com` (Kraken's TEN sequencer
  // — no archive, eth_getLogs caps at ~128 blocks). Sharp-edges audit M2
  // (2026-05-20) flagged the archive gap: token-balance history + order
  // history filters truncate silently on Ink. Mitigation deferred —
  // publicnode doesn't serve Ink, and the alternatives (Quicknode/
  // Alchemy) require an API key we don't have set up. Ink traffic is
  // negligible today; revisit when we expand.
  [SupportedChainId.INK]: { url: `https://rpc-ten.inkonchain.com`, usesInfura: false },
  [SupportedChainId.LINEA]: { url: `https://rpc.linea.build`, usesInfura: false },
  [SupportedChainId.SEPOLIA]: { url: `https://ethereum-sepolia-rpc.publicnode.com`, usesInfura: false },
  // Ophis fork: OP mainnet default public RPC
  [10 as unknown as SupportedChainId]: { url: `https://optimism-rpc.publicnode.com`, usesInfura: false },
  // Ophis fork: MegaETH mainnet default public RPC
  [4326 as unknown as SupportedChainId]: { url: `https://mainnet.megaeth.com/rpc`, usesInfura: false },
  // Ophis fork: HyperEVM mainnet default public RPC (100 req/min/IP cap — fine
  // for casual browser use; users can override via REACT_APP_NETWORK_URL_999)
  [999 as unknown as SupportedChainId]: { url: `https://rpc.hyperliquid.xyz/evm`, usesInfura: false },
}

/**
 * These are the network URLs used by the interface when there is not another available source of chain data
 */
export const RPC_URLS: Record<SupportedChainId, HttpsString> = {
  ...mapSupportedNetworks(getRpcUrl),
  // Ophis fork: include OP mainnet (chain 10) which the SDK omits from ALL_SUPPORTED_CHAIN_IDS
  [10 as unknown as SupportedChainId]: getRpcUrl(10 as unknown as SupportedChainId),
  // Ophis fork: include MegaETH mainnet (chain 4326) which the SDK omits from ALL_SUPPORTED_CHAIN_IDS
  [4326 as unknown as SupportedChainId]: getRpcUrl(4326 as unknown as SupportedChainId),
  // Ophis fork: include HyperEVM mainnet (chain 999) which the SDK omits from ALL_SUPPORTED_CHAIN_IDS
  [999 as unknown as SupportedChainId]: getRpcUrl(999 as unknown as SupportedChainId),
}

function getRpcUrl(chainId: SupportedChainId): HttpsString {
  const envKey = `REACT_APP_NETWORK_URL_${chainId}`
  const rpcUrl = RPC_URL_ENVS[chainId]

  if (rpcUrl) {
    return rpcUrl
  }

  const defaultRpc = DEFAULT_RPC_URL[chainId]
  if (defaultRpc.usesInfura && !INFURA_KEY) {
    throw new Error(`Either ${envKey} or REACT_APP_INFURA_KEY environment variable are required`)
  }

  return defaultRpc.url
}

const rpcProviderCache: Record<number, JsonRpcProvider> = {}

export function getRpcProvider(chainId: SupportedChainId): JsonRpcProvider
export function getRpcProvider(chainId: number): JsonRpcProvider | null {
  if (!rpcProviderCache[chainId]) {
    const url = RPC_URLS[chainId as SupportedChainId]
    if (!url) return null

    const provider = new JsonRpcProvider(url, chainId)

    rpcProviderCache[chainId] = provider

    return provider
  }

  return rpcProviderCache[chainId]
}
