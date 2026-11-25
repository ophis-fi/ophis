import { useAtomValue, useSetAtom } from 'jotai'
import { ReactNode, useEffect } from 'react'

import { ButtonPrimary, ButtonSecondary } from '@cowprotocol/ui'

import { Trans } from '@lingui/react/macro'
import { solanaConnectionAtom } from 'entities/solana'

import { NativeSolanaHistory } from './NativeSolanaHistory.container'

import * as styledEl from '../pure/NativeSolana.styled'
import { privateAction, privateSettlementEnabled } from '../services/privateSettlement.service'
import {
  manageNativeSolanaOrderAtom,
  orderActionMessageAtom,
  orderActionReceiptAtom,
  recordOrderActionAtom,
  savedNativeSolanaOrdersAtom,
  nativeSolanaOrderQueryAtom,
  visibleNativeSolanaOrdersAtom,
  type SavedNativeSolanaOrder,
  type SolverAttemptState,
} from '../state/orders.atoms'
import { nativeSolanaBusyAtom } from '../state/trade.atoms'

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

function NativeSolanaOrderCard({ order }: { order: SavedNativeSolanaOrder }): ReactNode {
  const { data, refetch, isFetching, isError } = useAtomValue(nativeSolanaOrderQueryAtom(order.uid))
  const manage = useSetAtom(manageNativeSolanaOrderAtom)
  const busy = useAtomValue(nativeSolanaBusyAtom)
  const message = useAtomValue(orderActionMessageAtom(order.uid))
  const receipt = useAtomValue(orderActionReceiptAtom(order.uid))
  const record = useSetAtom(recordOrderActionAtom)
  const action = order.walletAction
  const pending = action?.status === 'pending'
  useEffect(() => {
    if (pending && action && receipt.data && receipt.data !== 'pending')
      record({ uid: order.uid, signature: action.signature, lastHeight: action.lastHeight, status: receipt.data })
  }, [record, order.uid, action, pending, receipt.data])
  const cancelled = action?.status === 'confirmed' && !action.reclaim
  const open =
    ((data?.status === 'open' && !data.payoutConfirmed) || (isError && !data)) && !cancelled && !order.reclaimed
  const reclaimable = !order.reclaimed && (cancelled || (data && 'uid' in data && data.status !== 'open'))
  return (
    <styledEl.Card>
      <h3>{order.signature || data ? <Trans>Solana order</Trans> : <Trans>Swap attempt</Trans>}</h3>
      <code>{order.uid}</code>
      <p role="status">
        {order.reclaimed ? (
          <Trans>Storage deposit returned to the wallet that paid it.</Trans>
        ) : cancelled && (!data || data.status === 'open') ? (
          <Trans>Cancelled</Trans>
        ) : data?.status === 'failed' ? (
          <Trans>Order creation failed on Solana. Check your wallet activity.</Trans>
        ) : data?.status === 'unconfirmed' ? (
          <Trans>
            The transaction expired without a confirmed order. Check your wallet activity before requesting a new quote.
          </Trans>
        ) : data?.status === 'open' && data.payoutConfirmed ? (
          <Trans>Swap confirmed. Waiting for final trade history.</Trans>
        ) : data ? (
          data.status
        ) : order.signature ? (
          <Trans>Wallet submitted. Waiting for confirmation and indexing.</Trans>
        ) : (
          <Trans>Checking whether the order reached Solana.</Trans>
        )}
      </p>
      {privateSettlementEnabled && open && data?.status === 'open' && (
        <p role="status">
          <SolverAttempt attempt={data.settlementAttempt} stale={isError} />
        </p>
      )}
      {message && <p role={message.error ? 'alert' : 'status'}>{message.text}</p>}
      {pending && (
        <p role="status">
          {receipt.isError ? (
            <Trans>Could not check confirmation. Refresh status to check again.</Trans>
          ) : action.reclaim ? (
            <Trans>Refund submitted. Waiting for Solana to confirm.</Trans>
          ) : (
            <Trans>Cancellation submitted. Waiting for Solana to confirm.</Trans>
          )}
        </p>
      )}
      {privateSettlementEnabled && action?.signature && (
        <a href={'https://explorer.solana.com/tx/' + action.signature} target="_blank" rel="noreferrer">
          {action.reclaim ? <Trans>View refund transaction</Trans> : <Trans>View cancellation transaction</Trans>}
        </a>
      )}
      {!message && (action?.status === 'failed' || action?.status === 'expired') && (
        <p role="alert">
          <Trans>The wallet transaction failed or expired. Refresh the order before trying again.</Trans>
        </p>
      )}
      {!order.reclaimed && (
        <styledEl.Row>
          <ButtonSecondary
            type="button"
            disabled={pending ? receipt.isFetching : isFetching}
            onClick={() => void (pending ? receipt.refetch() : refetch())}
          >
            <Trans>Refresh status</Trans>
          </ButtonSecondary>
          {open && (
            <ButtonSecondary
              type="button"
              disabled={busy || pending}
              onClick={() => void manage({ uid: order.uid, reclaim: false })}
            >
              <Trans>Cancel order</Trans>
            </ButtonSecondary>
          )}
          {reclaimable && (
            <ButtonPrimary
              type="button"
              disabled={busy || pending}
              onClick={() => void manage({ uid: order.uid, reclaim: true })}
            >
              <Trans>Reclaim account rent</Trans>
            </ButtonPrimary>
          )}
        </styledEl.Row>
      )}
      {reclaimable && (
        <p>
          <Trans>
            Reclaiming closes this order’s storage account and returns its SOL deposit to the original payer. Your
            wallet pays the network fee.
          </Trans>
        </p>
      )}
    </styledEl.Card>
  )
}

export function NativeSolanaOrders(): ReactNode {
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
  return owner ? (
    <styledEl.Stack aria-label="Solana orders">
      <NativeSolanaHistory key={owner} />
      {orders.map((order) => (
        <NativeSolanaOrderCard key={order.uid} order={order} />
      ))}
    </styledEl.Stack>
  ) : null
}
