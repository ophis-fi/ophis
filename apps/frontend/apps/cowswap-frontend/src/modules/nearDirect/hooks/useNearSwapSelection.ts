import { useCallback, useState } from 'react'

import { getCurrencyAddress, isSupportedChainId } from '@cowprotocol/common-utils'
import { OrderKind } from '@cowprotocol/cow-sdk'
import { Currency } from '@cowprotocol/currency'

import { Field } from 'legacy/state/types'

import { useTradeNavigate } from 'modules/trade'

import { NearTransfer } from '../nearDirect.schemas'
import { NearSwapSelection } from '../useNearSwapEntry'

export function useNearSwapSelection(initial: NearSwapSelection, onExit: () => void) {
  const [selection, setSelection] = useState(initial)
  const [recipient, setRecipient] = useState('')
  const [refundTo, setRefundTo] = useState('')
  const [preview, setPreview] = useState<NearTransfer>()
  const [busy, setBusy] = useState(false)
  const navigate = useTradeNavigate()

  const select = useCallback(
    (field: Field, currency: Currency | null): void => {
      if (!currency || busy || preview) return
      if (field === Field.INPUT && isSupportedChainId(currency.chainId)) {
        void navigate(
          currency.chainId,
          {
            inputCurrencyId: getCurrencyAddress(currency),
            outputCurrencyId: selection.output ? getCurrencyAddress(selection.output) : null,
          },
          { targetChainId: selection.output?.chainId, kind: OrderKind.SELL, amount: selection.amount },
        )
        onExit()
        return
      }
      setSelection((current) => ({ ...current, [field === Field.INPUT ? 'input' : 'output']: currency }))
      if (field === Field.INPUT) setRefundTo('')
      else setRecipient('')
    },
    [busy, preview, selection, navigate, onExit],
  )

  const switchTokens = useCallback((): void => {
    if (!selection.output || busy || preview) return
    if (isSupportedChainId(selection.output.chainId)) {
      void navigate(
        selection.output.chainId,
        {
          inputCurrencyId: getCurrencyAddress(selection.output),
          outputCurrencyId: getCurrencyAddress(selection.input),
        },
        { targetChainId: selection.input.chainId, kind: OrderKind.SELL },
      )
      onExit()
      return
    }
    setSelection({ input: selection.output, output: selection.input, amount: '' })
    setRecipient('')
    setRefundTo('')
  }, [busy, preview, selection, navigate, onExit])

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
