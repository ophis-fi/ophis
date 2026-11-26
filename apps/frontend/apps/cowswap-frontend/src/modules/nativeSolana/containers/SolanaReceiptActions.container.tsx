import { useAtomValue, useSetAtom } from 'jotai'
import { ReactNode } from 'react'

import { ButtonSecondary } from '@cowprotocol/ui'

import { Trans } from '@lingui/react/macro'
import { formatOphisSolanaAmount } from '@ophis/solana-sdk'

import { useWalletActionReceipt } from '../hooks/useWalletActionReceipt'
import { receiptTxLink } from '../services/receipt.service'
import { orderDepositAtom } from '../state/history.atoms'
import { manageNativeSolanaOrderAtom, orderActionMessageAtom } from '../state/orderActions.atoms'
import { nativeSolanaBusyAtom } from '../state/trade.atoms'

import type { SavedNativeSolanaOrder } from '../state/orders.atoms'

export function ReceiptAction({ order, reclaim }: { order: SavedNativeSolanaOrder; reclaim: boolean }): ReactNode {
  const manage = useSetAtom(manageNativeSolanaOrderAtom)
  const busy = useAtomValue(nativeSolanaBusyAtom)
  return (
    <ButtonSecondary
      type="button"
      disabled={busy || order.walletAction?.status === 'pending'}
      onClick={() => void manage({ uid: order.uid, reclaim })}
    >
      {reclaim ? <Trans>Reclaim account rent</Trans> : <Trans>Cancel order</Trans>}
    </ButtonSecondary>
  )
}

export function WalletActionNotice({ order }: { order: SavedNativeSolanaOrder }): ReactNode {
  const message = useAtomValue(orderActionMessageAtom(order.uid))
  const receipt = useWalletActionReceipt(order)
  const action = order.walletAction
  const pending = action?.status === 'pending'
  const actionUrl = receiptTxLink(action?.signature)
  return (
    <>
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
      {actionUrl && (
        <a href={actionUrl} target="_blank" rel="noreferrer">
          {action?.reclaim ? <Trans>View refund transaction</Trans> : <Trans>View cancellation transaction</Trans>}
        </a>
      )}
      {!message && (action?.status === 'failed' || action?.status === 'expired') && (
        <p role="alert">
          <Trans>The wallet transaction failed or expired. Refresh the order before trying again.</Trans>
        </p>
      )}
    </>
  )
}

export function ReclaimDeposit({ order }: { order: SavedNativeSolanaOrder }): ReactNode {
  const { data } = useAtomValue(orderDepositAtom(order.uid))
  return (
    <>
      {typeof data === 'bigint' && (
        <p>
          <Trans>Storage deposit</Trans> · {formatOphisSolanaAmount(data, 9)} SOL
        </p>
      )}
      <p>
        <Trans>
          Reclaiming closes this order’s storage account and returns its SOL deposit to the original payer. Your wallet
          pays the network fee.
        </Trans>
      </p>
      <ReceiptAction order={order} reclaim />
    </>
  )
}
