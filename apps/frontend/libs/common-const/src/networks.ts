import { mapSupportedNetworks, SupportedChainId, HttpsString } from '@cowprotocol/cow-sdk'
import { JsonRpcProvider } from '@ethersproject/providers'

import { ROBINHOOD_CHAIN_PUBLIC_RPC } from './robinhood.const'

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
  // Ophis fork: Unichain (chain 130) added at frontend layer
  [130 as unknown as SupportedChainId]: (process.env['REACT_APP_NETWORK_URL_130'] as HttpsString) || undefined,
  // Ophis fork: Robinhood Chain (chain 4663)
  [4663 as unknown as SupportedChainId]: (process.env['REACT_APP_NETWORK_URL_4663'] as HttpsString) || undefined,
}

// Ophis fork (F1, 2026-05-20): defaults switched from Infura (which
// tracked every visitor's IP + swap intent) to publicnode endpoints.
// If REACT_APP_INFURA_KEY is set at deploy time, Infura is still
// attempted first for compatibility — see usesInfura branch in
// getRpcUrl(). The replacements below are still keyless and still avoid
// a shared tracked API key — that part of F1 stands.
//
// 2026-09-04: moved OFF publicnode (Allnodes) on every chain where a
// keyless replacement with real archive depth was verified. Allnodes'
// free endpoints are archive-gated ~128 blocks from head and answer
// anything deeper with jsonrpc -32602 "Archive requests require a
// personal token". Measured that day, head-128 already failed on
// ethereum, base, bnb, optimism AND arbitrum. On Arbitrum's ~0.25s
// blocks that is 30 SECONDS of history.
//
// This is not only our own reads: getRpcUrls() in
// libs/wallet/src/web3-react/utils/switchChain.ts hands these URLs to
// the user's wallet via wallet_addEthereumChain, so MetaMask inherits
// the same gate and surfaces the Allnodes error to the user directly.
// Same root cause as the 2026-08-23 OP settlement-indexer outage, which
// is documented in docs/operations/op-erpc-runbook.md.
//
// Each replacement was probed at head-1000 and head-100000 before being
// used here; base / optimism / avalanche also served head-2000000.
// arb1.arbitrum.io was REJECTED: it load-balances across nodes with
// different retention and answered -5000 ok, -20000 limited, -50000 ok
// in one pass, so its depth is not dependable.
//
// BNB is deliberately left on publicnode: bsc-dataseed is pruned and no
// keyless archive endpoint could be verified. It carries the same gate.
//
// Chain 10 is NOT mainnet.optimism.io, despite it being first-party and full
// archive. Our own operational record rejected that endpoint: erpc.yaml.tmpl
// records official-op as "chronically rate-limited from this host", measured
// 2026-08-29 at a sustained 4 req/s of uncacheable calls giving 12/160 = 7.5%
// HTTP 429. A frontend session issues concurrent balance/multicall/SDK reads,
// so making it the SOLE default would trade an archive error for intermittent
// ones. optimism.drpc.org matched it on every measure taken here — head-1000 /
// head-100000 / head-2000000 all served, and 48/48 under an 8-concurrent burst
// (mainnet.optimism.io also passed that burst; the 7.5% figure is SUSTAINED
// load, which a browser does not generate, but there is no reason to pick the
// endpoint carrying the adverse record when an equal one exists).
//
// KNOWN TRADE-OFF, recorded deliberately: this makes dRPC the default for four
// frontend chains while it is also a keyed lane in the OP eRPC stack. The
// frontend uses dRPC's keyless public endpoints from users' own IPs, so no
// quota is shared with our server-side lane, but a dRPC outage would touch
// both. Accepted because no other keyless endpoint met archive depth here.
const DEFAULT_RPC_URL: Record<SupportedChainId, { url: HttpsString; usesInfura: boolean }> = {
  [SupportedChainId.MAINNET]: { url: `https://eth.drpc.org`, usesInfura: false },
  [SupportedChainId.BNB]: { url: `https://bsc-rpc.publicnode.com`, usesInfura: false },
  [SupportedChainId.GNOSIS_CHAIN]: { url: `https://rpc.gnosis.gateway.fm`, usesInfura: false },
  [SupportedChainId.POLYGON]: { url: `https://polygon.drpc.org`, usesInfura: false },
  [SupportedChainId.BASE]: { url: `https://mainnet.base.org`, usesInfura: false },
  [SupportedChainId.PLASMA]: { url: `https://rpc.plasma.to`, usesInfura: false },
  [SupportedChainId.ARBITRUM_ONE]: { url: `https://arbitrum.drpc.org`, usesInfura: false },
  [SupportedChainId.AVALANCHE]: { url: `https://api.avax.network/ext/bc/C/rpc`, usesInfura: false },
  // Ink: kept upstream's `rpc-ten.inkonchain.com`. Sharp-edges audit M2
  // (2026-05-20) claimed this was non-archive but empirical testing
  // contradicted: returns 2009 logs over last 100 blocks, 1191 logs
  // over a 100-block window 10k blocks back, and serves block 100
  // (deep historical). Archive depth is adequate for our use case.
  // No change.
  [SupportedChainId.INK]: { url: `https://rpc-ten.inkonchain.com`, usesInfura: false },
  [SupportedChainId.LINEA]: { url: `https://rpc.linea.build`, usesInfura: false },
  [SupportedChainId.SEPOLIA]: { url: `https://ethereum-sepolia-rpc.publicnode.com`, usesInfura: false },
  // Ophis fork: OP mainnet default public RPC
  [10 as unknown as SupportedChainId]: { url: `https://optimism.drpc.org`, usesInfura: false },
  // Ophis fork: Unichain default public RPC
  [130 as unknown as SupportedChainId]: { url: `https://mainnet.unichain.org`, usesInfura: false },
  // Robinhood's official keyless public RPC.
  [4663 as unknown as SupportedChainId]: {
    // Wallet-safe fallback only. Robinhood documents this endpoint as
    // rate-limited; production deployments should set
    // REACT_APP_NETWORK_URL_4663 to their supervised/provider RPC.
    url: ROBINHOOD_CHAIN_PUBLIC_RPC,
    usesInfura: false,
  },
}

/**
 * These are the network URLs used by the interface when there is not another available source of chain data
 */
export const RPC_URLS: Record<SupportedChainId, HttpsString> = {
  ...mapSupportedNetworks(getRpcUrl),
  // Ophis fork: include OP mainnet (chain 10) which the SDK omits from ALL_SUPPORTED_CHAIN_IDS
  [10 as unknown as SupportedChainId]: getRpcUrl(10 as unknown as SupportedChainId),
  // Ophis fork: include Unichain (chain 130) which the SDK omits from ALL_SUPPORTED_CHAIN_IDS
  [130 as unknown as SupportedChainId]: getRpcUrl(130 as unknown as SupportedChainId),
  // Ophis fork: include Robinhood Chain (4663).
  [4663 as unknown as SupportedChainId]: getRpcUrl(4663 as unknown as SupportedChainId),
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
