import { useMemo } from 'react'

import { SupportedChainId } from '@cowprotocol/cow-sdk'

import ms from 'ms.macro'
import useSWR from 'swr'
import { usePublicClient } from 'wagmi'

import { OPHIS_ETHEREUM_OTC_MANIFEST } from './otc.const'
import { computeIndexLag, fetchOtcIndexedOrders } from './otcSubgraph'
import { readOtcSnapshot } from './readOtcSnapshot'
import { reconcileOtcOrders } from './reconcileOtcOrders'

import type {
  OtcDataState,
  OtcEnrichment,
  OtcManifest,
  OtcReaderClient,
  OtcReconciliationReport,
  OtcSnapshot,
} from './otc.types'

const REFRESH_INTERVAL = ms`30s`

export interface LoadedOtcData {
  snapshot: OtcSnapshot
  enrichment: OtcEnrichment | null
  reconciliation: OtcReconciliationReport | null
  indexLagBlocks: bigint | null
  /** True when the index is unavailable or stale; on-chain state is still authoritative. */
  degraded: boolean
}

export interface LoadOtcDataOptions {
  manifest?: OtcManifest
  fetchImpl?: typeof fetch
}

/**
 * Loads the on-chain snapshot (authority; a failure here throws so nothing
 * unverified is shown) and decorates it with subgraph enrichment when the
 * index is healthy. Index failure or excessive lag only degrades the result.
 */
export async function loadOtcData(client: OtcReaderClient, options: LoadOtcDataOptions = {}): Promise<LoadedOtcData> {
  const manifest = options.manifest ?? OPHIS_ETHEREUM_OTC_MANIFEST

  const [snapshot, indexResult] = await Promise.all([
    readOtcSnapshot(client, manifest),
    fetchOtcIndexedOrders(options.fetchImpl ?? fetch).then(
      (value) => ({ ok: true as const, value }),
      () => ({ ok: false as const }),
    ),
  ])

  if (!indexResult.ok) {
    return { snapshot, enrichment: null, reconciliation: null, indexLagBlocks: null, degraded: true }
  }

  const { orders, indexedBlock } = indexResult.value
  const enrichment: OtcEnrichment = {
    byOrderId: new Map(orders.map((order) => [order.orderId.toString(), order])),
    indexedBlock,
  }
  const reconciliation = reconcileOtcOrders(orders, snapshot)
  const indexLagBlocks = computeIndexLag(indexedBlock, snapshot.blockNumber)

  return {
    snapshot,
    enrichment,
    reconciliation,
    indexLagBlocks,
    degraded: indexLagBlocks > manifest.maxIndexLagBlocks,
  }
}

function toReaderClient(publicClient: NonNullable<ReturnType<typeof usePublicClient>>): OtcReaderClient {
  return {
    getLatestBlock: async () => publicClient.getBlock({ blockTag: 'latest' }),
    getBlockByNumber: async (blockNumber) => publicClient.getBlock({ blockNumber }),
    getCode: (address, blockNumber) => publicClient.getCode({ address, blockNumber }),
    call: async (request) => publicClient.call(request),
  }
}

/**
 * Ethereum-mainnet-pinned OTC data. Wallet-independent: reads go through the
 * configured network provider, never the connected wallet's chain.
 */
export function useOtcData(enabled: boolean): OtcDataState {
  const publicClient = usePublicClient({ chainId: SupportedChainId.MAINNET })
  const client = useMemo<OtcReaderClient | null>(
    () => (publicClient ? toReaderClient(publicClient) : null),
    [publicClient],
  )

  const { data, error } = useSWR(
    enabled && client ? ['ophis-otc-data'] : null,
    async () => (client ? loadOtcData(client) : null),
    {
      refreshInterval: REFRESH_INTERVAL,
      revalidateOnFocus: false,
      revalidateIfStale: false,
      refreshWhenHidden: false,
      refreshWhenOffline: false,
      isPaused: () => typeof document !== 'undefined' && !document.hasFocus(),
    },
  )

  if (error) {
    return { status: 'unavailable', snapshot: null, enrichment: null, reconciliation: null, indexLagBlocks: null }
  }
  if (!data) {
    return { status: 'loading', snapshot: null, enrichment: null, reconciliation: null, indexLagBlocks: null }
  }

  return {
    status: data.degraded ? 'degraded' : 'ready',
    snapshot: data.snapshot,
    enrichment: data.enrichment,
    reconciliation: data.reconciliation,
    indexLagBlocks: data.indexLagBlocks,
  }
}
