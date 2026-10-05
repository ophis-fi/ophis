import { SetStateAction, useCallback, useEffect, useState } from 'react'

import { STARKNET_CHAIN_ID } from '@cowprotocol/common-const'
import { getCurrencyAddress, isSupportedChainId } from '@cowprotocol/common-utils'
import { OrderKind } from '@cowprotocol/cow-sdk'
import { Currency } from '@cowprotocol/currency'

import { Field } from 'legacy/state/types'

import { useTradeNavigate, useTradeState } from 'modules/trade'

import { useStarknetWallet } from './useStarknetWallet'

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
  const { connection } = useStarknetWallet()
  const connectedAddress = connection?.address
  const [selection, setSelection] = useState(initial)
  const [recipient, setRecipient] = useState('')
  const [refundTo, setRefundTo] = useState('')
  useEffect(() => {
    if (selection.input.chainId === STARKNET_CHAIN_ID && connection?.address)
      setRefundTo((current) => current || connection.address)
  }, [selection.input, connection?.address])
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

  const select = useCallback(
    (field: Field, currency: Currency | null): void => {
      if (!currency || busy || preview) return
      const opposite = field === Field.INPUT ? selection.output : selection.input
      if (opposite?.equals(currency)) {
        switchTokens()
        return
      }
      if (field === Field.INPUT && isSupportedChainId(currency.chainId)) {
        exitToStandard(currency, selection.output)
        return
      }
      setSelection((current) => ({
        ...current,
        [field === Field.INPUT ? 'input' : 'output']: currency,
        amount: field === Field.INPUT ? '' : current.amount,
      }))
      if (field === Field.INPUT) setRefundTo(sourceRefundAddress(currency, connectedAddress))
      else setRecipient('')
    },
    [busy, preview, selection, exitToStandard, switchTokens, connectedAddress],
  )

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

function sourceRefundAddress(currency: Currency, starknetAddress: string | undefined): string {
  return currency.chainId === STARKNET_CHAIN_ID ? (starknetAddress ?? '') : ''
}
