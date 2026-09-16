import { useCallback } from 'react'

import { getRpcProvider } from '@cowprotocol/common-const'
import { normalizeError } from '@cowprotocol/common-utils'
import { useWalletProvider } from '@cowprotocol/wallet-provider'

import { t } from '@lingui/core/macro'

import { getSwapErrorMessage } from 'common/utils/getSwapErrorMessage'

import { approveDirectInput } from '../services/wholeToken/input.service'
import { DirectQuote } from '../services/wholeToken/router.service'

export function useDirectApproval(
  wallet: ReturnType<typeof useWalletProvider>,
  requestKey: string,
  current: { current: string },
  busy: { current: boolean },
  setStatus: (
    update: (previous: { pending: boolean; message: string; hash: string; submitted: DirectQuote | null }) => {
      pending: boolean
      message: string
      hash: string
      submitted: DirectQuote | null
    },
  ) => void,
): (quote: DirectQuote) => Promise<boolean> {
  return useCallback(
    async (quote: DirectQuote): Promise<boolean> => {
      if (!wallet || busy.current) return false
      busy.current = true
      setStatus((previous) => ({ ...previous, pending: true, message: t`Approve USDC in your wallet` }))
      try {
        await approveDirectInput(wallet, getRpcProvider(1), quote, () => current.current === requestKey)
        setStatus((previous) => ({ ...previous, pending: false, message: t`Approved. Refreshing quote.` }))
        return true
      } catch (error) {
        setStatus((previous) => ({ ...previous, pending: false, message: getSwapErrorMessage(normalizeError(error)) }))
        return false
      } finally {
        busy.current = false
      }
    },
    [wallet, requestKey, setStatus, current, busy],
  )
}
