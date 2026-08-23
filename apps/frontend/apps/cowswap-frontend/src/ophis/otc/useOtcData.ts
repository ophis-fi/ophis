import { useAtomValue } from 'jotai'
import { useEffect, useId, useMemo, useRef } from 'react'

import { withTimeout } from '@cowprotocol/common-utils'
import { SupportedChainId } from '@cowprotocol/cow-sdk'

import { atomWithQuery } from 'jotai-tanstack-query'
import ms from 'ms.macro'
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
    withTimeout(readOtcSnapshot(client, manifest), manifest.readTimeoutMs, 'Ophis OTC read timed out'),
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

  return {
    snapshot,
    enrichment,
    reconciliation,
    indexLagBlocks,
    degradedReason: resolveDegradedReason({
      manifest,
      snapshot,
      orders,
      droppedRows,
      indexedBlock,
      reconciliation,
      indexLagBlocks,
    }),
  }
}

/**
 * Degradation taxonomy, most severe first:
 * - node-stale: the index checkpoint is materially AHEAD of this RPC node's
 *   head — the node, not the index, is behind, so even 'on-chain' state may
 *   be obsolete. Outranks index reasons: when the node itself is suspect, no
 *   notice may claim on-chain state is current;
 * - index-corrupt: malformed rows dropped, interior coverage holes (an id
 *   missing from the index BETWEEN ids it does have), or a fresh index that
 *   is empty while the chain has orders;
 * - index-stale: the index checkpoint lags the chain beyond the bound.
 */
function resolveDegradedReason(input: {
  manifest: OtcManifest
  snapshot: OtcSnapshot
  orders: readonly { orderId: bigint }[]
  droppedRows: number
  indexedBlock: bigint
  reconciliation: OtcReconciliationReport
  indexLagBlocks: bigint
}): OtcDegradedReason | null {
  const { manifest, snapshot, orders, droppedRows, indexedBlock, reconciliation, indexLagBlocks } = input
  if (indexedBlock > snapshot.blockNumber + manifest.maxIndexLagBlocks) return 'node-stale'
  if (droppedRows > 0) return 'index-corrupt'
  if (orders.length === 0 && snapshot.orders.length > 0) return 'index-corrupt'
  if (hasInteriorHoles(orders, reconciliation)) return 'index-corrupt'
  if (indexLagBlocks > manifest.maxIndexLagBlocks) return 'index-stale'
  return null
}

/** An id missing from the index BETWEEN ids it does have is a coverage hole. */
function hasInteriorHoles(orders: readonly { orderId: bigint }[], reconciliation: OtcReconciliationReport): boolean {
  if (orders.length === 0) return false
  let min = orders[0].orderId
  let max = orders[0].orderId
  for (const order of orders) {
    if (order.orderId < min) min = order.orderId
    if (order.orderId > max) max = order.orderId
  }
  return reconciliation.notIndexed.some((orderId) => orderId >= min && orderId <= max)
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
export function useOtcData(enabled: boolean, refreshSignal = 0): OtcDataState {
  const publicClient = usePublicClient({ chainId: SupportedChainId.MAINNET })
  const client = useMemo<OtcReaderClient | null>(
    () => (publicClient ? toOtcReaderClient(publicClient) : null),
    [publicClient],
  )

  // Mount-unique key: a cached snapshot from a previous visit must never
  // render as 'ready' — every mount starts at loading until its own
  // verified round-trip completes (same rule as the detail page).
  const mountId = useId()
  const dataQueryAtom = useMemo(
    () =>
      atomWithQuery<LoadedOtcData | null, Error>(() => ({
        queryKey: ['ophis-otc-data', mountId],
        queryFn: async () => (client ? loadOtcData(client) : null),
        enabled: enabled && !!client,
        refetchInterval: OTC_DATA_REFRESH_INTERVAL,
        refetchIntervalInBackground: false,
        refetchOnWindowFocus: false,
      })),
    [client, enabled, mountId],
  )
  const { data, error, refetch } = useAtomValue(dataQueryAtom)
  const observedRefreshSignal = useRef(refreshSignal)
  useEffect(() => {
    if (observedRefreshSignal.current === refreshSignal) return
    observedRefreshSignal.current = refreshSignal
    void refetch()
  }, [refetch, refreshSignal])

  return useMemo(() => {
    if (error) return { status: 'unavailable', ...EMPTY_STATE }
    if (!data) return { status: 'loading', ...EMPTY_STATE }
    return {
      status: data.degradedReason ? 'degraded' : 'ready',
      degradedReason: data.degradedReason,
      snapshot: data.snapshot,
      enrichment: data.enrichment,
      reconciliation: data.reconciliation,
      indexLagBlocks: data.indexLagBlocks,
    }
  }, [data, error])
}
