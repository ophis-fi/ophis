import { RPC_URLS } from '@cowprotocol/common-const'
import { SupportedChainId } from '@cowprotocol/cow-sdk'

import { safe, injected } from '@wagmi/connectors'
import { Chain, defineChain, http } from 'viem'
import {
  arbitrum,
  avalanche,
  base,
  bsc,
  gnosis,
  ink,
  linea,
  mainnet,
  optimism,
  plasma,
  polygon,
  sepolia,
  unichain,
} from 'viem/chains'
import { createConfig, Transport } from 'wagmi'

const SUPPORTED_CHAIN_IDS = Object.values(SupportedChainId).filter((v) => typeof v === 'number')

// Ophis fork: OP mainnet (chain 10) added at frontend layer.
const OPTIMISM_CHAIN_ID = 10 as unknown as SupportedChainId
// Ophis fork: Unichain (chain 130) added at frontend layer, same pattern as OP.
const UNICHAIN_CHAIN_ID = 130 as unknown as SupportedChainId
const ROBINHOOD_CHAIN_ID = 4663 as unknown as SupportedChainId
const robinhood = defineChain({
  id: 4663,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.mainnet.chain.robinhood.com'] } },
  blockExplorers: {
    default: { name: 'Robinhood Chain Blockscout', url: 'https://robinhoodchain.blockscout.com' },
  },
})
const ALL_CHAIN_IDS_FOR_WAGMI: SupportedChainId[] = [
  ...SUPPORTED_CHAIN_IDS,
  OPTIMISM_CHAIN_ID,
  UNICHAIN_CHAIN_ID,
  ROBINHOOD_CHAIN_ID,
]

// Persisted wallet state can outlive the supported-chain registry. Purge any
// store containing an unsupported chain before wagmi hydrates it, otherwise a
// stale connection can make wagmi dereference a missing chain and crash boot.
if (typeof window !== 'undefined') {
  try {
    const supported = new Set<number>(ALL_CHAIN_IDS_FOR_WAGMI as number[])
    for (const key of ['wagmi.store', 'wagmi.cache', 'redux_localstorage_simple_user']) {
      const raw = window.localStorage.getItem(key)
      const chainIds = raw?.matchAll(/"chainId":\s*(\d+)/g)
      if (chainIds && Array.from(chainIds, (match) => Number(match[1])).some((chainId) => !supported.has(chainId))) {
        window.localStorage.removeItem(key)
      }
    }
  } catch {
    // Storage can be unavailable during SSR or in privacy-restricted contexts.
  }
}

const SUPPORTED_CHAINS: Record<SupportedChainId, Chain> = {
  [SupportedChainId.MAINNET]: mainnet,
  [SupportedChainId.BNB]: bsc,
  [SupportedChainId.GNOSIS_CHAIN]: gnosis,
  [SupportedChainId.POLYGON]: polygon,
  [SupportedChainId.BASE]: base,
  [SupportedChainId.PLASMA]: plasma,
  [SupportedChainId.ARBITRUM_ONE]: arbitrum,
  [SupportedChainId.AVALANCHE]: avalanche,
  [SupportedChainId.LINEA]: linea,
  [SupportedChainId.INK]: ink,
  [SupportedChainId.SEPOLIA]: sepolia,
  [OPTIMISM_CHAIN_ID]: optimism,
  [UNICHAIN_CHAIN_ID]: unichain,
  [ROBINHOOD_CHAIN_ID]: robinhood,
}

// Defensive guard: `SUPPORTED_CHAINS[chainId]` returns undefined if the
// `chains` map ever drifts out of sync with `ALL_CHAIN_IDS_FOR_WAGMI`
// (see PR #167 incident above). `.filter(Boolean)` ensures any future
// drift surfaces as "this chain isn't actually supported" rather than
// "the entire SPA crashes on load with a cryptic TypeError".
const WAGMI_CHAINS = ALL_CHAIN_IDS_FOR_WAGMI.map((chainId) => SUPPORTED_CHAINS[chainId]).filter(
  (chain): chain is Chain => Boolean(chain),
)

if (WAGMI_CHAINS.length === 0) {
  throw new Error(
    'wagmi config: no supported chains resolved — check SUPPORTED_CHAINS map vs ALL_CHAIN_IDS_FOR_WAGMI',
  )
}

export const config = createConfig({
  chains: WAGMI_CHAINS as [Chain, ...Chain[]],
  transports: ALL_CHAIN_IDS_FOR_WAGMI.reduce(
    (acc, chainId) => {
      const chain = SUPPORTED_CHAINS[chainId]
      if (chain) {
        acc[chainId] = http(RPC_URLS[chainId])
      }
      return acc
    },
    {} as Record<SupportedChainId, Transport>,
  ),
  connectors: [safe(), injected()],
})
