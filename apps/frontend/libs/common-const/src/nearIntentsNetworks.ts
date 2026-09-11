import { registerEvmChainIds } from '@cowprotocol/cow-sdk'
import { registerNearIntentsNetworks } from '@cowprotocol/sdk-bridging'

import { toBridgeChainInfo } from './bridgeChainInfo'
import { MONAD_CHAIN_ID, XLAYER_CHAIN_ID } from './bridgeDestinationChains'

/**
 * NEAR Intents networks Ophis offers on top of the SDK's built-in list. The
 * slug is NEAR's `blockchain` field in its 1Click token list. Destinations
 * only: a NEAR bridge is a plain swap with the receiver pointed at NEAR's
 * deposit address, so nothing on these chains needs deploying.
 */
export const OPHIS_NEAR_INTENTS_NETWORKS: ReadonlyArray<{ blockchain: string; chainId: number }> = [
  { blockchain: 'monad', chainId: MONAD_CHAIN_ID },
  { blockchain: 'xlayer', chainId: XLAYER_CHAIN_ID },
]

/** Idempotent; call once at boot before the NEAR provider is first used (both apps). */
export function registerOphisNearIntentsNetworks(): void {
  // EVM for address handling (recipient validation, token address matching)
  // without widening the SDK's EvmChains enum.
  registerEvmChainIds(OPHIS_NEAR_INTENTS_NETWORKS.map(({ chainId }) => chainId))
  registerNearIntentsNetworks(
    OPHIS_NEAR_INTENTS_NETWORKS.map(({ blockchain, chainId }) => ({ blockchain, chain: toBridgeChainInfo(chainId) })),
  )
}
