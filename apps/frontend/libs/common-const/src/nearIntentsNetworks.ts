import { registerEvmChainIds } from '@cowprotocol/cow-sdk'
import { registerNearIntentsNetworks } from '@cowprotocol/sdk-bridging'

import { toBridgeChainInfo } from './bridgeChainInfo'
import {
  HYPE_NATIVE_CURRENCY_ADDRESS,
  HYPERCORE_CHAIN_ID,
  MONAD_CHAIN_ID,
  SUI_CHAIN_ID,
  SUI_NATIVE_CURRENCY_ADDRESS,
  TRON_CHAIN_ID,
  TRX_NATIVE_CURRENCY_ADDRESS,
  XLAYER_CHAIN_ID,
} from './bridgeDestination.const'

export type OphisNearIntentsNetwork = {
  /** NEAR's `blockchain` field in its 1Click token list. */
  blockchain: string
  chainId: number
  /**
   * 1Click rejects FLEX_INPUT for this chain's assets ("supports only EXACT_INPUT or
   * EXACT_OUTPUT"). The SDK then quotes EXACT_INPUT on the order's minimum buy amount:
   * the deposit is never below it, and NEAR refunds the settlement surplus above it to
   * the owner on the source chain instead of delivering it.
   */
  exactInput?: boolean
} & (
  | {
      /** EVM chain: isEvmChain() applies, 0x handling, native = the SDK's ETH sentinel. */
      evm: true
      nativeAddress?: never
    }
  | {
      /** Non-EVM chain: MUST have a rule in common-utils nonEvmDestinations.ts (a test enforces it). */
      evm: false
      /** Sentinel for the chain's native asset (NEAR lists it without a contractAddress). */
      nativeAddress: string
    }
)

/**
 * NEAR Intents networks Ophis offers on top of the SDK's built-in list.
 * Destinations only: a NEAR bridge is a plain swap with the receiver pointed
 * at NEAR's deposit address, so nothing on these chains needs deploying.
 */
export const OPHIS_NEAR_INTENTS_NETWORKS: ReadonlyArray<OphisNearIntentsNetwork> = [
  { blockchain: 'monad', chainId: MONAD_CHAIN_ID, evm: true },
  { blockchain: 'xlayer', chainId: XLAYER_CHAIN_ID, evm: true },
  { blockchain: 'sui', chainId: SUI_CHAIN_ID, evm: false, nativeAddress: SUI_NATIVE_CURRENCY_ADDRESS },
  { blockchain: 'tron', chainId: TRON_CHAIN_ID, evm: false, nativeAddress: TRX_NATIVE_CURRENCY_ADDRESS },
  {
    blockchain: 'hypercore',
    chainId: HYPERCORE_CHAIN_ID,
    evm: false,
    nativeAddress: HYPE_NATIVE_CURRENCY_ADDRESS,
    exactInput: true,
  },
]

/** Idempotent; call once at boot before the NEAR provider is first used (both apps). */
export function registerOphisNearIntentsNetworks(): void {
  registerEvmChainIds(OPHIS_NEAR_INTENTS_NETWORKS.filter(({ evm }) => evm).map(({ chainId }) => chainId))
  registerNearIntentsNetworks(
    OPHIS_NEAR_INTENTS_NETWORKS.map(({ blockchain, chainId, nativeAddress, exactInput }) => ({
      blockchain,
      chain: toBridgeChainInfo(chainId),
      nativeAddress,
      exactInput,
    })),
  )
}
