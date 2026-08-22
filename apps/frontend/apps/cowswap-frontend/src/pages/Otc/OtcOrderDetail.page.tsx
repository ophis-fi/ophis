/**
 * OtcOrderDetailPage — /otc/:orderId (OTC Milestone B, read-only).
 *
 * Opening a detail view performs a DIRECT getOrder read against Ethereum
 * (with the pinned code-hash check) — indexed data is never presented as
 * current state. An indexed-row disagreement remains visible, but fork-only
 * actions rely on their separate local-fork verification and exact preflight.
 */
import { useAtomValue } from 'jotai'
import { useCallback, useId, useMemo, useState, type ReactNode } from 'react'

import { SupportedChainId } from '@cowprotocol/cow-sdk'

import { atomWithQuery } from 'jotai-tanstack-query'
import {
  readOtcOrder,
  toOtcReaderClient,
  useOtcData,
  OPHIS_ETHEREUM_OTC_MANIFEST,
  OTC_DATA_REFRESH_INTERVAL,
} from 'ophis/otc'
import { OtcOrderActionPanel } from 'ophis/otcWrite'
import { Navigate, useParams } from 'react-router'
import { usePublicClient } from 'wagmi'

import { Routes as RoutesEnum } from 'common/constants/routes'

import { assessDetailFreshness, type OtcNodeFreshness } from './otcDetailFreshness.utils'
import { OtcOrderDetailView } from './OtcOrderDetailView.pure'
import { useOtcNow } from './useOtcNow'
import { useOtcPageEnabled, useOtcWriteEnabled } from './useOtcPageEnabled'

import type { OtcReaderClient } from 'ophis/otc'

function parseOtcOrderId(rawOrderId: string): bigint | null {
  return /^\d{1,18}$/.test(rawOrderId) ? BigInt(rawOrderId) : null
}

function VerifiedOtcOrderDetailPage({
  rawOrderId,
  orderId,
  writeEnabled,
}: {
  rawOrderId: string
  orderId: bigint
  writeEnabled: boolean
}): ReactNode {
  const [refreshSignal, setRefreshSignal] = useState(0)
  const nowMs = useOtcNow()
  const publicClient = usePublicClient({ chainId: SupportedChainId.MAINNET })
  const client = useMemo<OtcReaderClient | null>(
    () => (publicClient ? toOtcReaderClient(publicClient) : null),
    [publicClient],
  )
  const state = useOtcData(true, refreshSignal)

  // Mount-unique key: the query cache must never serve an order from a previous
  // visit as if it were the promised fresh direct read — every mount starts
  // at loading until its own getOrder round-trip completes.
  const mountId = useId()
  const orderQueryAtom = useMemo(
    () =>
      atomWithQuery<Awaited<ReturnType<typeof readOtcOrder>> | null, Error>(() => ({
        queryKey: ['ophis-otc-order', rawOrderId, mountId],
        queryFn: async () => (client ? readOtcOrder(client, orderId) : null),
        enabled: !!client,
        refetchInterval: OTC_DATA_REFRESH_INTERVAL,
        refetchIntervalInBackground: false,
        refetchOnWindowFocus: false,
      })),
    [client, mountId, orderId, rawOrderId],
  )
  const { data, error, refetch } = useAtomValue(orderQueryAtom)
  const refresh = useCallback(() => {
    setRefreshSignal((current) => current + 1)
    void refetch()
  }, [refetch])

  const indexed = state.enrichment?.byOrderId.get(orderId.toString()) ?? null
  // Freshness must describe the backend that served THIS read: compare the
  // index checkpoint against the direct read's own block (see
  // otcDetailFreshness). Terms never render before the assessment resolves,
  // and a terminal failure of the direct read outranks the pending check.
  const freshnessPending = state.status === 'loading'
  const freshness: OtcNodeFreshness = assessDetailFreshness(
    state,
    data?.blockNumber ?? null,
    OPHIS_ETHEREUM_OTC_MANIFEST.maxIndexLagBlocks,
  )
  const order = data?.order ?? null

  return (
    <OtcOrderDetailView
      orderId={orderId}
      loading={!error && (!data || freshnessPending)}
      failed={Boolean(error)}
      freshness={freshness}
      order={order}
      blockNumber={data?.blockNumber ?? null}
      indexed={indexed}
      nowMs={nowMs}
      writeEnabled={writeEnabled}
      actionPanel={writeEnabled ? <OtcOrderActionPanel orderId={orderId} onConfirmed={refresh} /> : undefined}
    />
  )
}

export function OtcOrderDetailPage(): ReactNode {
  const enabled = useOtcPageEnabled()
  const writeEnabled = useOtcWriteEnabled()
  const rawOrderId = useParams().orderId ?? ''
  const orderId = parseOtcOrderId(rawOrderId)

  if (!enabled) return <Navigate to={RoutesEnum.HOME} replace />
  if (orderId === null) return <Navigate to={RoutesEnum.OTC} replace />
  return <VerifiedOtcOrderDetailPage rawOrderId={rawOrderId} orderId={orderId} writeEnabled={writeEnabled} />
}
