import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'

import { isRejectRequestProviderError } from '@cowprotocol/common-utils'
import { useSwitchNetwork } from '@cowprotocol/wallet'

import type { toOtcForkClients } from './otcWriteAdapters'

export function useOtcNetworkSwitch(
  mainnet: boolean,
  walletClient: Parameters<typeof toOtcForkClients>[0] | undefined,
  setError: (error: string | null) => void,
  resetKey: string,
): { switching: boolean; switchToEthereum(): Promise<void> } {
  const switchLegacyNetwork = useSwitchNetwork()
  const [switching, setSwitching] = useState(false)
  const inFlight = useRef(false)
  const contextGeneration = useRef(0)
  const connection = walletClient ?? switchLegacyNetwork
  useLayoutEffect(() => {
    contextGeneration.current += 1
    inFlight.current = false
    setSwitching(false)
    return () => {
      contextGeneration.current += 1
    }
  }, [mainnet, connection, resetKey])
  const switchToEthereum = useCallback(async () => {
    if (!mainnet) {
      setError(
        'Select your chain-id-1 Anvil fork network in the wallet. Automatic switching to real Ethereum is disabled.',
      )
      return
    }
    if (inFlight.current) return
    const generation = contextGeneration.current
    inFlight.current = true
    setSwitching(true)
    setError(null)
    try {
      if (walletClient) await walletClient.switchChain({ id: 1 })
      else await switchLegacyNetwork(1)
    } catch (error) {
      if (contextGeneration.current === generation)
        setError(
          isRejectRequestProviderError(error)
            ? 'Network switch rejected in your wallet.'
            : 'Could not switch to Ethereum. Try again in your wallet.',
        )
    } finally {
      if (contextGeneration.current === generation) {
        inFlight.current = false
        setSwitching(false)
      }
    }
  }, [mainnet, setError, switchLegacyNetwork, walletClient])
  return useMemo(() => ({ switching, switchToEthereum }), [switching, switchToEthereum])
}
