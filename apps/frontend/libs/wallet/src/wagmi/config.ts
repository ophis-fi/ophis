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
  hyperEvm,
  ink,
  linea,
  mainnet,
  megaeth,
  optimism,
  plasma,
  polygon,
  sepolia,
} from 'viem/chains'
import { createConfig, Transport } from 'wagmi'

const SUPPORTED_CHAIN_IDS = Object.values(SupportedChainId).filter((v) => typeof v === 'number')

// Ophis fork: OP mainnet (chain 10), MegaETH mainnet (chain 4326), and HyperEVM
// mainnet (chain 999) added at frontend layer.
const OPTIMISM_CHAIN_ID = 10 as unknown as SupportedChainId
const MEGAETH_CHAIN_ID = 4326 as unknown as SupportedChainId
const HYPEREVM_CHAIN_ID = 999 as unknown as SupportedChainId
const ALL_CHAIN_IDS_FOR_WAGMI: SupportedChainId[] = [
  ...SUPPORTED_CHAIN_IDS,
  OPTIMISM_CHAIN_ID,
  MEGAETH_CHAIN_ID,
  HYPEREVM_CHAIN_ID,
]

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
  [MEGAETH_CHAIN_ID]: megaeth,
  [HYPEREVM_CHAIN_ID]: hyperEvm,
}

export const config = createConfig({
  chains: ALL_CHAIN_IDS_FOR_WAGMI.map((chainId) => SUPPORTED_CHAINS[chainId]) as [Chain, ...Chain[]],
  transports: ALL_CHAIN_IDS_FOR_WAGMI.reduce(
    (acc, chainId) => {
      acc[chainId] = http(RPC_URLS[chainId])
      return acc
    },
    {} as Record<SupportedChainId, Transport>,
  ),
  connectors: [safe(), injected()],
})
