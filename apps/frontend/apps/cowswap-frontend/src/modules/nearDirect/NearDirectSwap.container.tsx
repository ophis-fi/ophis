import { useAtomValue } from 'jotai'
import { ReactNode, useMemo } from 'react'

import { tryParseCurrencyAmount } from '@cowprotocol/common-utils'
import { Currency, CurrencyAmount } from '@cowprotocol/currency'

import { Field } from 'legacy/state/types'

import { TradeWidget } from 'modules/trade'

import { CurrencyInfo } from 'common/pure/CurrencyInputPanel/types'

import { useNearSwapSelection } from './hooks/useNearSwapSelection'
import { nearTokensAtom } from './nearDirect.atoms'
import { findNearToken, nearTokenPickerOptions } from './nearSwapAssets.utils'
import { NearSwapDetails } from './NearSwapDetails.container'
import { NearSwapSelection } from './useNearSwapEntry'

export function NearDirectSwap({ initial, onExit }: { initial: NearSwapSelection; onExit(): void }): ReactNode {
  const { data: tokens, isPending, error: tokenError, refetch } = useAtomValue(nearTokensAtom)
  const form = useNearSwapSelection(initial, onExit)
  const {
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
  } = form
  const source = findNearToken(tokens ?? [], selection.input)
  const destination = findNearToken(tokens ?? [], selection.output)
  const tokenOptions = useMemo(() => nearTokenPickerOptions(tokens ?? [], true), [tokens])
  const buyTokenOptions = useMemo(() => nearTokenPickerOptions(tokens ?? []), [tokens])
  const inputAmount = tryParseCurrencyAmount(selection.amount, selection.input) ?? null
  const quoteAmount = inputAmount?.toExact() ?? ''
  const outputAmount =
    preview && selection.output
      ? CurrencyAmount.fromRawAmount(selection.output, preview.response.quote.amountOut)
      : null
  const bottomContent = (): ReactNode => (
    <NearSwapDetails
      source={source}
      destination={destination}
      amount={quoteAmount}
      recipient={recipient}
      refundTo={refundTo}
      setRefundTo={setRefundTo}
      preview={preview}
      setPreview={setPreview}
      busy={busy}
      setBusy={setBusy}
      isPending={isPending}
      tokenError={!!tokenError}
      refetch={refetch}
    />
  )

  return (
    <TradeWidget
      inputCurrencyInfo={currencyInfo(Field.INPUT, selection.input, inputAmount)}
      outputCurrencyInfo={currencyInfo(Field.OUTPUT, selection.output, outputAmount)}
      actions={{
        onCurrencySelection: select,
        onSwitchTokens: switchTokens,
        onChangeRecipient: (value) => {
          if (!busy && !preview) setRecipient(value ?? '')
        },
        onUserInput: (field, value) => {
          if (field === Field.INPUT && !busy && !preview)
            setSelection((current) => ({ ...current, amount: value ?? '' }))
        },
      }}
      params={{
        externalFunding: true,
        compactView: true,
        showRecipient: true,
        recipient,
        isTradePriceUpdating: busy,
        isPriceStatic: true,
        hideTradeWarnings: true,
        disablePriceImpact: true,
        inputsDisabled: busy || !!preview,
        isMarketOrderWidget: true,
        displayChainName: true,
        inputTokenOptions: tokenOptions,
        outputTokenOptions: buyTokenOptions,
        priceImpact: { priceImpact: undefined, loading: false },
      }}
      disableOutput
      slots={{ settingsWidget: null, selectTokenWidget: <></>, bottomContent }}
    />
  )
}

function currencyInfo(field: Field, currency: Currency | null, amount: CurrencyAmount<Currency> | null): CurrencyInfo {
  return {
    field,
    currency,
    amount,
    label: field === Field.INPUT ? 'You sell' : 'You receive',
    isIndependent: field === Field.INPUT,
    balance: null,
    fiatAmount: null,
    receiveAmountInfo: null,
  }
}
