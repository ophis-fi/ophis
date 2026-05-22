import { RPC_URLS } from '@cowprotocol/common-const'
import { SupportedChainId } from '@cowprotocol/cow-sdk'

import { safe, injected } from '@wagmi/connectors'
import { Chain, http } from 'viem'
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
} from 'viem/chains'
import { createConfig, Transport } from 'wagmi'

const SUPPORTED_CHAIN_IDS = Object.values(SupportedChainId).filter((v) => typeof v === 'number')

// Ophis fork: OP mainnet (chain 10) added at frontend layer.
//
// PR #167 (2026-05-21) removed MegaETH (4326) and HyperEVM (999) from
// the FE chain list because those backends aren't production-wired.
// That PR dropped the `SUPPORTED_CHAINS` map entries but LEFT the
// corresponding `*_CHAIN_ID` constants in `ALL_CHAIN_IDS_FOR_WAGMI`.
// Net result: the `chains:` array passed to wagmi's `createConfig`
// contained 2 trailing `undefined` slots. Any wagmi internal hook
// that does `chains.find(c => c.id === chainId)` inside its
// `useSyncExternalStore` selector then dereferenced `c.id` against
// `undefined` and threw — taking the entire SPA down with
// `Cannot read properties of undefined (reading 'id')` on every
// page load.
//
// Fix landed in P0 hotfix 2026-05-22: drop the two dangling chain
// IDs entirely + add `filter(Boolean)` belt-and-suspenders guard at
// the array-build site so the next incomplete sweep can't repeat
// this exact crash mode.
const OPTIMISM_CHAIN_ID = 10 as unknown as SupportedChainId
const ALL_CHAIN_IDS_FOR_WAGMI: SupportedChainId[] = [...SUPPORTED_CHAIN_IDS, OPTIMISM_CHAIN_ID]

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
