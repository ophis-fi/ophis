import { SetStateAction, useCallback, useState } from 'react'

import { getCurrencyAddress, isSupportedChainId } from '@cowprotocol/common-utils'
import { OrderKind } from '@cowprotocol/cow-sdk'
import { Currency } from '@cowprotocol/currency'

import { Field } from 'legacy/state/types'

import { useTradeNavigate, useTradeState } from 'modules/trade'

import { NearTransfer } from '../nearDirect.schemas'
import { NearSwapSelection } from '../useNearSwapEntry'

interface NearSwapFormState {
  selection: NearSwapSelection
  setSelection(value: SetStateAction<NearSwapSelection>): void
  recipient: string
  setRecipient(value: string): void
  refundTo: string
  setRefundTo(value: string): void
  preview: NearTransfer | undefined
  setPreview(value: NearTransfer | undefined): void
  busy: boolean
  setBusy(value: boolean): void
  select(field: Field, currency: Currency | null): void
  switchTokens(): void
}

export function useNearSwapSelection(initial: NearSwapSelection, onExit: () => void): NearSwapFormState {
  const [selection, setSelection] = useState(initial)
  const [recipient, setRecipient] = useState('')
  const [refundTo, setRefundTo] = useState('')
  const [preview, setPreview] = useState<NearTransfer>()
  const [busy, setBusy] = useState(false)
  const navigate = useTradeNavigate()
  const { updateState } = useTradeState()

  const exitToStandard = useCallback(
    (input: Currency, output: Currency | null): void => {
      if (!updateState) return
      updateState({
        inputCurrencyAmount: null,
        outputCurrencyAmount: null,
        orderKind: OrderKind.SELL,
        recipient: null,
        recipientAddress: null,
      })
      void navigate(
        input.chainId,
        { inputCurrencyId: getCurrencyAddress(input), outputCurrencyId: output ? getCurrencyAddress(output) : null },
        { targetChainId: output?.chainId, kind: OrderKind.SELL, amount: '', clearRecipient: true },
      )
      onExit()
    },
    [navigate, updateState, onExit],
  )

  const select = useCallback(
    (field: Field, currency: Currency | null): void => {
      if (!currency || busy || preview) return
      if (field === Field.INPUT && isSupportedChainId(currency.chainId)) {
        exitToStandard(currency, selection.output)
        return
      }
      setSelection((current) => ({
        ...current,
        [field === Field.INPUT ? 'input' : 'output']: currency,
        amount: field === Field.INPUT ? '' : current.amount,
      }))
      if (field === Field.INPUT) setRefundTo('')
      else setRecipient('')
    },
    [busy, preview, selection, exitToStandard],
  )

  const switchTokens = useCallback((): void => {
    if (!selection.output || busy || preview) return
    if (isSupportedChainId(selection.output.chainId)) {
      exitToStandard(selection.output, selection.input)
      return
    }
    setSelection({ input: selection.output, output: selection.input, amount: '' })
    setRecipient('')
    setRefundTo('')
  }, [busy, preview, selection, exitToStandard])

  return {
    selection,
    setSelection,
    recipient,
    setRecipient,
    refundTo,
    setRefundTo,
    preview,
    setPreview,
    busy,
    setBusy,
    select,
    switchTokens,
  }
}
