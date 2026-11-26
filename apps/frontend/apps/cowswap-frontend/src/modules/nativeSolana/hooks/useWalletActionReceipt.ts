import { useAtomValue, useSetAtom, type ExtractAtomValue } from 'jotai'
import { useEffect } from 'react'

import { orderActionReceiptAtom, recordOrderActionAtom } from '../state/orderActions.atoms'

import type { SavedNativeSolanaOrder } from '../state/orders.atoms'

export function useWalletActionReceipt({
  uid,
  walletAction,
}: SavedNativeSolanaOrder): ExtractAtomValue<ReturnType<typeof orderActionReceiptAtom>> {
  const receipt = useAtomValue(orderActionReceiptAtom(uid))
  const record = useSetAtom(recordOrderActionAtom)
  const status = receipt.data
  useEffect(() => {
    if (walletAction?.status === 'pending' && status && status !== 'pending') {
      record({ uid, signature: walletAction.signature, lastHeight: walletAction.lastHeight, status })
    }
  }, [uid, walletAction, status, record])
  return receipt
}
