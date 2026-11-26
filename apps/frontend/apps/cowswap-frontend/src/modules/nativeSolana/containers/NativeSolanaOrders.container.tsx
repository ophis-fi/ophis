import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { ReactNode, useEffect } from 'react'

import { ButtonSecondary } from '@cowprotocol/ui'

import { Trans } from '@lingui/react/macro'
import { solanaConnectionAtom } from 'entities/solana'
import { useAssetVerificationResolver } from 'entities/verifiedAsset'

import { ReceiptAction, ReclaimDeposit, WalletActionNotice } from './SolanaReceiptActions.container'
import { SolanaSettlementTime } from './SolanaSettlementTime.container'

import { useReceiptTrade } from '../hooks/useReceiptTrade'
import { useWalletActionReceipt } from '../hooks/useWalletActionReceipt'
import { SolanaReceipt } from '../pure/SolanaReceipt.pure'
import { isSolanaMainnet } from '../services/assets.service'
import { privateAction, privateSettlementEnabled } from '../services/privateSettlement.service'
import { savedReceiptStatus, type ReceiptStatus } from '../services/receipt.service'
import { solanaMainnetCatalogAtom, walletAssetListAtom } from '../state/assets.atoms'
import { orderActionReceiptAtom } from '../state/orderActions.atoms'
import {
  activeSolanaReceiptAtom,
  savedNativeSolanaOrdersAtom,
  nativeSolanaOrderQueryAtom,
  visibleNativeSolanaOrdersAtom,
  type SavedNativeSolanaOrder,
  type SolverAttemptState,
  type SolanaOrderResult,
} from '../state/orders.atoms'
import { clearNativeSolanaReviewAtom, nativeSolanaErrorAtom } from '../state/trade.atoms'

import type { OphisSolanaTrade } from '@ophis/solana-sdk'

function SolverAttempt({ attempt, stale }: { attempt?: { state: SolverAttemptState }; stale: boolean }): ReactNode {
  switch (stale ? undefined : attempt?.state) {
    case 'failed':
      return <Trans>The settlement transaction failed. Your order is still open.</Trans>
    case 'expired':
      return <Trans>The settlement transaction expired before it landed. Your order is still open.</Trans>
    case 'inactive':
      return <Trans>The solver has stopped working on this order. You can cancel it below.</Trans>
    case 'pending':
      return <Trans>Checking whether the settlement landed on Solana.</Trans>
    case 'confirmed':
      return <Trans>The settlement finalized. Checking the order receipt.</Trans>
    case 'searching':
      return <Trans>The Ophis solver is looking for a fill at your minimum price or better.</Trans>
    default:
      return <Trans>Waiting for a settlement status update.</Trans>
  }
}

function ReceiptNotice({
  data,
  trade,
  status,
  isError,
}: {
  data?: SolanaOrderResult
  trade?: OphisSolanaTrade
  status: ReceiptStatus
  isError: boolean
}): ReactNode {
  return (
    <>
      {data?.status === 'unconfirmed' && !trade && (
        <p>
          <Trans>
            The transaction expired without a confirmed order. Check your wallet activity before requesting a new quote.
          </Trans>
        </p>
      )}
      {data?.status === 'failed' && !trade && (
        <p>
          <Trans>Order creation failed on Solana. Check your wallet activity.</Trans>
        </p>
      )}
      {status === 'pending' && (
        <p role="status">
          <Trans>Checking whether the order reached Solana.</Trans>
        </p>
      )}
      {status === 'fulfilled' && !trade && (
        <p role="status">
          <Trans>Swap confirmed. Waiting for final trade history.</Trans>
        </p>
      )}
      {privateSettlementEnabled && status === 'open' && data?.status === 'open' && (
        <p role="status">
          <SolverAttempt attempt={data.settlementAttempt} stale={isError} />
        </p>
      )}
    </>
  )
}

function receiptActions(
  order: SavedNativeSolanaOrder,
  status: ReceiptStatus,
  data: SolanaOrderResult | undefined,
  trade: OphisSolanaTrade | undefined,
  isError: boolean,
): { open: boolean; reclaimable: boolean } {
  if (order.executionMode === 'walletAtomic') return { open: false, reclaimable: false }
  const open = status === 'open' || (status === 'pending' && isError)
  const reclaimable =
    !order.reclaimed &&
    ['fulfilled', 'cancelled', 'expired'].includes(status) &&
    !(data?.status === 'open' && data.payoutConfirmed && !trade)
  return { open, reclaimable }
}

export function NativeSolanaOrderCard({
  order,
  indexed,
  onBack,
}: {
  order: SavedNativeSolanaOrder
  indexed?: OphisSolanaTrade
  onBack(): void
}): ReactNode {
  const { data, refetch, isFetching, isError } = useAtomValue(nativeSolanaOrderQueryAtom(order.uid))
  const hasFill = savedReceiptStatus(order, data) === 'fulfilled' || order.reclaimed
  const { trade, refreshTrade, checkOlder, isFetchingTrade } = useReceiptTrade(order, hasFill, indexed)
  useAtomValue(solanaMainnetCatalogAtom)
  const assets = useAtomValue(walletAssetListAtom)
  const receipt = useAtomValue(orderActionReceiptAtom(order.uid))
  const status = savedReceiptStatus(order, data, trade)
  const { open, reclaimable } = receiptActions(order, status, data, trade, isError)
  const verifyAsset = useAssetVerificationResolver(isSolanaMainnet)
  return (
    <SolanaReceipt
      verifyAsset={verifyAsset}
      timing={
        trade && (
          <SolanaSettlementTime slot={trade.slot} created={data && 'uid' in data ? data.creationDate : undefined} />
        )
      }
      saved={order}
      trade={trade}
      data={data && 'uid' in data ? data : undefined}
      status={status}
      assets={assets}
      onBack={onBack}
      notice={
        <>
          <ReceiptNotice data={data} trade={trade} status={status} isError={isError} />
          <WalletActionNotice order={order} />
        </>
      }
      actions={open && <ReceiptAction order={order} reclaim={false} />}
      details={
        <>
          {order.reclaimed ? (
            <p>
              <Trans>Storage deposit returned to the wallet that paid it.</Trans>
            </p>
          ) : (
            <ButtonSecondary
              type="button"
              disabled={isFetching || receipt.isFetching || isFetchingTrade}
              onClick={() => {
                if (order.walletAction?.status === 'pending') void receipt.refetch()
                else void refetch()
                void refreshTrade?.()
              }}
            >
              <Trans>Refresh status</Trans>
            </ButtonSecondary>
          )}
          {checkOlder && (
            <ButtonSecondary type="button" onClick={checkOlder}>
              <Trans>Check older settlements</Trans>
            </ButtonSecondary>
          )}
          {reclaimable && <ReclaimDeposit order={order} />}
        </>
      }
    />
  )
}

function OrderStatusObserver({ order }: { order: SavedNativeSolanaOrder }): null {
  useAtomValue(nativeSolanaOrderQueryAtom(order.uid))
  useWalletActionReceipt(order)
  return null
}

export function NativeSolanaOrders({ children }: { children?: ReactNode }): ReactNode {
  const [uid, select] = useAtom(activeSolanaReceiptAtom)
  const clearReview = useSetAtom(clearNativeSolanaReviewAtom)
  const clearError = useSetAtom(nativeSolanaErrorAtom)
  const orders = useAtomValue(visibleNativeSolanaOrdersAtom)
  const owner = useAtomValue(solanaConnectionAtom)?.account.address
  const save = useSetAtom(savedNativeSolanaOrdersAtom)
  useEffect(() => {
    if (!privateSettlementEnabled || !owner) return
    let current = true
    void privateAction<SavedNativeSolanaOrder | null>('previous-order', { owner })
      .then((order) => {
        if (current && order?.owner === owner) save((all) => (all[order.uid] ? all : { ...all, [order.uid]: order }))
      })
      .catch(() => undefined)
    return () => {
      current = false
    }
  }, [owner, save])
  const order = orders.find((entry) => entry.uid === uid)
  return (
    <>
      {orders.map((entry) => (entry.reclaimed ? null : <OrderStatusObserver key={entry.uid} order={entry} />))}
      {order ? (
        <NativeSolanaOrderCard
          key={order.uid}
          order={order}
          onBack={() => {
            select(null)
            clearReview()
            clearError(null)
          }}
        />
      ) : (
        children
      )}
    </>
  )
}
