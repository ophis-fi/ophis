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
  OtcDegradedReason,
  OtcEnrichment,
  OtcManifest,
  OtcReaderClient,
  OtcReconciliationReport,
  OtcSnapshot,
} from './otc.types'

export const OTC_DATA_REFRESH_INTERVAL = ms`30s`

export interface LoadedOtcData {
  snapshot: OtcSnapshot
  enrichment: OtcEnrichment | null
  reconciliation: OtcReconciliationReport | null
  indexLagBlocks: bigint | null
  /** Set when the index is unavailable or stale; on-chain state stays authoritative. */
  degradedReason: OtcDegradedReason | null
}

export interface LoadOtcDataOptions {
  manifest?: OtcManifest
  fetchImpl?: typeof fetch
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Ophis OTC read timed out')), timeoutMs)
    promise.then(
      (value) => {
        clearTimeout(timeout)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timeout)
        reject(error)
      },
    )
  })
}

/**
 * Loads the on-chain snapshot (authority; a failure or timeout here throws so
 * nothing unverified is shown) and decorates it with subgraph enrichment when
 * the index is healthy. Index failure or excessive lag only degrades the
 * result — with the reason kept distinct so the UI never claims data is
 * hidden while stale data is being shown.
 */
export async function loadOtcData(client: OtcReaderClient, options: LoadOtcDataOptions = {}): Promise<LoadedOtcData> {
  const manifest = options.manifest ?? OPHIS_ETHEREUM_OTC_MANIFEST

  const [snapshot, indexResult] = await Promise.all([
    withTimeout(readOtcSnapshot(client, manifest), manifest.readTimeoutMs),
    fetchOtcIndexedOrders(options.fetchImpl ?? fetch, manifest).then(
      (value) => ({ ok: true as const, value }),
      () => ({ ok: false as const }),
    ),
  ])

  if (!indexResult.ok) {
    return {
      snapshot,
      enrichment: null,
      reconciliation: null,
      indexLagBlocks: null,
      degradedReason: 'index-unavailable',
    }
  }

  const { orders, indexedBlock, droppedRows } = indexResult.value
  const enrichment: OtcEnrichment = {
    byOrderId: new Map(orders.map((order) => [order.orderId.toString(), order])),
    indexedBlock,
  }
  const reconciliation = reconcileOtcOrders(orders, snapshot)
  const indexLagBlocks = computeIndexLag(indexedBlock, snapshot.blockNumber)

  // Malformed rows were dropped and must not pass silently as 'ready';
  // corruption outranks staleness in the reason taxonomy.
  const degradedReason: OtcDegradedReason | null =
    droppedRows > 0 ? 'index-corrupt' : indexLagBlocks > manifest.maxIndexLagBlocks ? 'index-stale' : null

  return { snapshot, enrichment, reconciliation, indexLagBlocks, degradedReason }
}

type WagmiPublicClient = NonNullable<ReturnType<typeof usePublicClient>>

/** Wrap a viem PublicClient into the narrow, transaction-free reader interface. */
export function toOtcReaderClient(publicClient: WagmiPublicClient): OtcReaderClient {
  return {
    getChainId: () => publicClient.getChainId(),
    getLatestBlock: async () => publicClient.getBlock({ blockTag: 'latest' }),
    getBlockByNumber: async (blockNumber) => publicClient.getBlock({ blockNumber }),
    getCode: (address, blockNumber) => publicClient.getCode({ address, blockNumber }),
    call: async (request) => publicClient.call(request),
  }
}

const EMPTY_STATE = {
  snapshot: null,
  enrichment: null,
  reconciliation: null,
  indexLagBlocks: null,
  degradedReason: null,
} as const

/**
 * Ethereum-mainnet-pinned OTC data. Wallet-independent: reads go through the
 * configured network provider, never the connected wallet's chain.
 */
export function useOtcData(enabled: boolean): OtcDataState {
  const publicClient = usePublicClient({ chainId: SupportedChainId.MAINNET })
  const client = useMemo<OtcReaderClient | null>(
    () => (publicClient ? toOtcReaderClient(publicClient) : null),
    [publicClient],
  )

  const { data, error } = useSWR(
    enabled && client ? ['ophis-otc-data'] : null,
    async () => (client ? loadOtcData(client) : null),
    {
      refreshInterval: OTC_DATA_REFRESH_INTERVAL,
      revalidateOnFocus: false,
      refreshWhenHidden: false,
      refreshWhenOffline: false,
    },
  )

  if (error) {
    return { status: 'unavailable', ...EMPTY_STATE }
  }
  if (!data) {
    return { status: 'loading', ...EMPTY_STATE }
  }

  return {
    status: data.degradedReason ? 'degraded' : 'ready',
    degradedReason: data.degradedReason,
    snapshot: data.snapshot,
    enrichment: data.enrichment,
    reconciliation: data.reconciliation,
    indexLagBlocks: data.indexLagBlocks,
  }
}
