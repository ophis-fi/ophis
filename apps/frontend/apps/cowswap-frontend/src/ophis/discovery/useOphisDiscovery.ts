import { useEffect, useMemo, useState } from 'react'

import { SupportedChainId } from '@cowprotocol/cow-sdk'

import { usePublicClient } from 'wagmi'

import { OPHIS_DISCOVERY_TIMEOUT_MS } from './ophisDiscovery.const'
import { readOphisDiscovery } from './readOphisDiscovery'

import type { OphisDiscoveryReaderClient, OphisDiscoveryState } from './ophisDiscovery.types'

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => reject(new Error('Ophis discovery timed out')), timeoutMs)
    promise.then(
      (value) => {
        window.clearTimeout(timeout)
        resolve(value)
      },
      (error: unknown) => {
        window.clearTimeout(timeout)
        reject(error)
      },
    )
  })
}

export function useOphisDiscovery(enabled: boolean, routeChainId: number | undefined): OphisDiscoveryState {
  const publicClient = usePublicClient({ chainId: SupportedChainId.MAINNET })
  const client = useMemo<OphisDiscoveryReaderClient | null>(() => {
    if (!publicClient) return null

    return {
      getLatestBlock: async () => publicClient.getBlock({ blockTag: 'latest' }),
      getBlockByNumber: async (blockNumber) => publicClient.getBlock({ blockNumber }),
      getCode: (address, blockNumber) => publicClient.getCode({ address, blockNumber }),
      call: (request) => publicClient.call(request),
    }
  }, [publicClient])

  const [state, setState] = useState<OphisDiscoveryState>({ status: 'idle', snapshot: null })

  useEffect(() => {
    if (!enabled || routeChainId !== SupportedChainId.MAINNET || !client) {
      setState({ status: 'idle', snapshot: null })
      return
    }

    let cancelled = false
    setState({ status: 'loading', snapshot: null })

    withTimeout(readOphisDiscovery(client), OPHIS_DISCOVERY_TIMEOUT_MS).then(
      (snapshot) => {
        if (!cancelled) setState({ status: 'ready', snapshot })
      },
      () => {
        if (!cancelled) setState({ status: 'unavailable', snapshot: null })
      },
    )

    return () => {
      cancelled = true
    }
  }, [client, enabled, routeChainId])

  return state
}
