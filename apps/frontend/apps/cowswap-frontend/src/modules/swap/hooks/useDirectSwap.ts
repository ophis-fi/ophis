import { atom, useAtom } from 'jotai'
import { atomFamily } from 'jotai/utils'
import { useCallback, useEffect, useMemo, useRef } from 'react'

import { getRpcProvider } from '@cowprotocol/common-const'
import { OrderKind } from '@cowprotocol/cow-sdk'
import { CurrencyAmount } from '@cowprotocol/currency'
import { UiOrderType } from '@cowprotocol/types'
import { useWalletProvider } from '@cowprotocol/wallet-provider'
import { WidgetHookEvents } from '@cowprotocol/widget-lib'

import { replaceTransaction } from 'legacy/state/enhancedTransactions/actions'
import { useTransactionAdder } from 'legacy/state/enhancedTransactions/hooks'
import { useAppDispatch } from 'legacy/state/hooks'

import { buildTradeWidgetHookPayload, callWidgetHook } from 'modules/injectedWidget'

import { useSwapDerivedState } from './useSwapDerivedState'

import { executeDirectSwap, waitForDirectReceipt } from '../services/wholeToken/execute.service'
import { DirectQuote } from '../services/wholeToken/router.service'

const executionAtom = atomFamily((_: string) =>
  atom({ pending: false, message: '', hash: '', submitted: null as DirectQuote | null }),
)

export function useDirectSwap(requestKey: string): {
  pending: boolean
  message: string
  hash: string
  submitted: DirectQuote | null
  execute: (quote: DirectQuote) => Promise<void>
} {
  const wallet = useWalletProvider()
  const dispatch = useAppDispatch()
  const addTransaction = useTransactionAdder()
  const { inputCurrency, outputCurrency } = useSwapDerivedState()
  const [status, setStatus] = useAtom(executionAtom(requestKey))
  const current = useRef(requestKey)
  const busy = useRef(false)
  useEffect(() => {
    current.current = requestKey
    return () => {
      current.current = ''
    }
  }, [requestKey])
  const execute = useCallback(
    async (quote: DirectQuote): Promise<void> => {
      if (!wallet || !inputCurrency || !outputCurrency) return
      if ([busy.current, status.pending, status.submitted === quote].some(Boolean)) return
      busy.current = true
      setStatus((previous) => ({ ...previous, pending: true, message: 'Confirm in your wallet' }))
      try {
        const input = CurrencyAmount.fromRawAmount(inputCurrency, quote.sellAmount.toString())
        const output = CurrencyAmount.fromRawAmount(outputCurrency, quote.buyAmount.toString())
        const maximum = quote.maxTotal - quote.gasLimit * quote.maxFeePerGas
        const allowed = await callWidgetHook(
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
        if (!allowed) throw new Error('Swap cancelled by wallet host.')
        const isCurrent = (): boolean => current.current === requestKey
        const tx = await executeDirectSwap(wallet, getRpcProvider(1), quote, isCurrent, status.hash)
        await addTransaction({ hash: tx.hash, summary: `Buy ${quote.buyAmount} MPS on Uniswap` })
        setStatus({ pending: true, message: 'Transaction pending', hash: tx.hash, submitted: quote })
        const receipt = await waitForDirectReceipt(tx, (hash, cancelled) => {
          dispatch(
            replaceTransaction({ chainId: 1, oldHash: tx.hash, newHash: hash, type: cancelled ? 'cancel' : 'speedup' }),
          )
          setStatus((previous) => ({ ...previous, hash }))
        })
        if (receipt.status !== 1) throw new Error('Transaction reverted.')
        const message = `Received ${quote.buyAmount} MPS`
        setStatus({ pending: false, message, hash: receipt.transactionHash, submitted: quote })
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Swap failed. Check your wallet before retrying.'
        setStatus((previous) => ({ ...previous, pending: false, message }))
      } finally {
        busy.current = false
      }
    },
    [wallet, inputCurrency, outputCurrency, status, setStatus, requestKey, addTransaction, dispatch],
  )
  return useMemo(() => ({ ...status, execute }), [status, execute])
}
