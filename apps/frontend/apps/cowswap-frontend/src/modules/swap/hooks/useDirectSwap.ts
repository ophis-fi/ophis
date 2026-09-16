import { atom, useAtom } from 'jotai'
import { atomFamily } from 'jotai/utils'
import { useCallback, useEffect, useMemo, useRef } from 'react'

import { getRpcProvider } from '@cowprotocol/common-const'
import { captureError, ERROR_TYPES, normalizeError } from '@cowprotocol/common-utils'
import { OrderKind } from '@cowprotocol/cow-sdk'
import { Currency, CurrencyAmount } from '@cowprotocol/currency'
import { UiOrderType } from '@cowprotocol/types'
import { useWalletProvider } from '@cowprotocol/wallet-provider'
import { WidgetHookEvents } from '@cowprotocol/widget-lib'

import { t } from '@lingui/core/macro'

import { replaceTransaction } from 'legacy/state/enhancedTransactions/actions'
import { useTransactionAdder } from 'legacy/state/enhancedTransactions/hooks'
import { useAppDispatch } from 'legacy/state/hooks'

import { buildTradeWidgetHookPayload, callWidgetHook } from 'modules/injectedWidget'
import { useTradeFlowAnalytics } from 'modules/trade'

import { getSwapErrorMessage } from 'common/utils/getSwapErrorMessage'

import { useSwapDerivedState } from './useSwapDerivedState'

import { executeDirectSwap, waitForDirectReceipt } from '../services/wholeToken/execute.service'
import { approveDirectInput } from '../services/wholeToken/input.service'
import { DirectQuote } from '../services/wholeToken/router.service'

const executionAtom = atomFamily((_: string) =>
  atom({ pending: false, message: '', hash: '', submitted: null as DirectQuote | null }),
)

export function useDirectSwap(requestKey: string): {
  pending: boolean
  message: string
  hash: string
  submitted: DirectQuote | null
  approve: (quote: DirectQuote) => Promise<boolean>
  execute: (quote: DirectQuote) => Promise<void>
} {
  const wallet = useWalletProvider()
  const dispatch = useAppDispatch()
  const analytics = useTradeFlowAnalytics()
  const addTransaction = useTransactionAdder()
  const { inputCurrency, outputCurrency } = useSwapDerivedState()
  const [status, setStatus] = useAtom(executionAtom(requestKey))
  const current = useCurrentRequest(requestKey)
  const busy = useRef(false)
  const execute = useCallback(
    async (quote: DirectQuote): Promise<void> => {
      if (!wallet || !inputCurrency || !outputCurrency) return
      if ([busy.current, status.pending, status.submitted === quote].some(Boolean)) return
      busy.current = true
      setStatus((previous) => ({ ...previous, pending: true, message: t`Confirm in your wallet` }))
      const context = {
        account: quote.account,
        orderType: UiOrderType.SWAP,
        marketLabel: `${inputCurrency.symbol}/MPS`,
      }
      try {
        const allowed = await confirmHost(quote, inputCurrency, outputCurrency)
        if (!allowed) {
          setStatus((previous) => ({ ...previous, pending: false, message: t`Swap cancelled by wallet host.` }))
          return
        }
        analytics.trade(context)
        const isCurrent = (): boolean => current.current === requestKey
        const tx = await executeDirectSwap(wallet, getRpcProvider(1), quote, isCurrent, status.hash)
        analytics.sign(context)
        const buyAmount = quote.buyAmount.toString()
        await addTransaction({ hash: tx.hash, summary: t`Buy ${buyAmount} MPS on Uniswap` })
        setStatus({ pending: true, message: t`Transaction pending`, hash: tx.hash, submitted: quote })
        const receipt = await waitForDirectReceipt(tx, (hash, cancelled) => {
          dispatch(
            replaceTransaction({ chainId: 1, oldHash: tx.hash, newHash: hash, type: cancelled ? 'cancel' : 'speedup' }),
          )
          setStatus((previous) => ({ ...previous, hash }))
        })
        if (receipt.status !== 1) throw new Error(t`Transaction reverted.`)
        const message = t`Received ${buyAmount} MPS`
        setStatus({ pending: false, message, hash: receipt.transactionHash, submitted: quote })
      } catch (error) {
        const normalized = normalizeError(error)
        const message = getSwapErrorMessage(normalized)
        analytics.error(normalized, message, context)
        captureError(normalized, ERROR_TYPES.ON_SWAP)
        setStatus((previous) => ({ ...previous, pending: false, message }))
      } finally {
        busy.current = false
      }
    },
    [
      wallet,
      analytics,
      inputCurrency,
      outputCurrency,
      status,
      setStatus,
      requestKey,
      addTransaction,
      dispatch,
      current,
    ],
  )
  const approve = useDirectApproval(wallet, requestKey, current, busy, setStatus)
  return useMemo(() => ({ ...status, execute, approve }), [status, execute, approve])
}

function useDirectApproval(
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

function useCurrentRequest(requestKey: string): { current: string } {
  const current = useRef(requestKey)
  useEffect(() => {
    current.current = requestKey
    return () => {
      current.current = ''
    }
  }, [requestKey])
  return current
}

async function confirmHost(quote: DirectQuote, inputCurrency: Currency, outputCurrency: Currency): Promise<boolean> {
  const input = CurrencyAmount.fromRawAmount(inputCurrency, quote.sellAmount.toString())
  const output = CurrencyAmount.fromRawAmount(outputCurrency, quote.buyAmount.toString())
  const maximum = quote.maxTotal - (quote.inputToken ? 0n : quote.gasLimit * quote.maxFeePerGas)
  return callWidgetHook(
    WidgetHookEvents.ON_BEFORE_TRADE,
    buildTradeWidgetHookPayload({
      orderType: UiOrderType.SWAP,
      orderKind: OrderKind.SELL,
      inputAmount: input,
      outputAmount: output,
      recipient: quote.recipient,
      maximumSendSellAmount: CurrencyAmount.fromRawAmount(inputCurrency, maximum.toString()),
    }),
  )
}
