import { useEffect, useRef } from 'react'

import { type BtcSwapPending } from './btcSwapState'
import { updateBtcSwap } from './btcSwapSubmission.service'
import { type useCctpTransfer } from './useCctpTransfer'

export function useSaveBtcSwapHash(
  pending: BtcSwapPending | null,
  settlementHash: BtcSwapPending['settlementHash'],
  persist: (value: BtcSwapPending | null) => void,
  { run, busy }: ReturnType<typeof useCctpTransfer>,
): void {
  const attempted = useRef('')
  useEffect(() => {
    const key = `${pending?.orderUid}:${settlementHash}`
    if (busy || !pending || pending.settlementHash || !settlementHash || attempted.current === key) return
    attempted.current = key
    void run('Saving swap recovery', () =>
      updateBtcSwap(pending, async () => ({ ...pending, settlementHash }), persist),
    )
  }, [pending, settlementHash, persist, run, busy])
}
