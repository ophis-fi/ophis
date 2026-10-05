import { useAtomValue } from 'jotai'
import { ReactNode, useCallback, useEffect, useMemo, useRef } from 'react'

import { tryParseCurrencyAmount } from '@cowprotocol/common-utils'
import { Currency, CurrencyAmount } from '@cowprotocol/currency'

import { AssetSwapFields } from 'ophis/components/AssetSwap/AssetSwapFields'

import { Field } from 'legacy/state/types'

import { TradeWidget } from 'modules/trade'
import { useSetTradeQuoteParams } from 'modules/tradeQuote'

import { CurrencyInfo } from 'common/pure/CurrencyInputPanel/types'

import { useNearSwapSelection } from './hooks/useNearSwapSelection'
import { nearTokensAtom } from './nearDirect.atoms'
import * as styledEl from './nearDirect.styled'
import { findNearToken, nearTokenPickerOptions } from './nearSwapAssets.utils'
import { NearSwapDetails } from './NearSwapDetails.container'
import { NearSwapSelection } from './useNearSwapEntry'

export function NearDirectSwap({ initial, onExit }: { initial: NearSwapSelection; onExit(): void }): ReactNode {
  useSetTradeQuoteParams({ amount: null })
  const { data: tokens, isPending, error: tokenError, refetch } = useAtomValue(nearTokensAtom)
  const form = useNearSwapSelection(initial, onExit)
  const { selection, setSelection, recipient, setRecipient, refundTo, setRefundTo } = form
  const { preview, setPreview, busy, setBusy, select, switchTokens } = form
  const reviewHeading = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    if (!preview) return
    reviewHeading.current?.focus({ preventScroll: true })
    reviewHeading.current?.scrollIntoView({ block: 'start' })
  }, [preview])
  const source = findNearToken(tokens ?? [], selection.input)
  const destination = findNearToken(tokens ?? [], selection.output)
  const tokenOptions = useMemo(() => nearTokenPickerOptions(tokens ?? [], true), [tokens])
  const buyTokenOptions = useMemo(() => nearTokenPickerOptions(tokens ?? []), [tokens])
  const { inputAmount, quoteAmount } = useMemo(() => {
    const inputAmount = tryParseCurrencyAmount(selection.amount, selection.input) ?? null
    return { inputAmount, quoteAmount: inputAmount?.toExact() ?? '' }
  }, [selection.amount, selection.input])
  const bottomContent = useCallback(
    (): ReactNode => (
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
    ),
    [
      source,
      destination,
      quoteAmount,
      recipient,
      refundTo,
      setRefundTo,
      preview,
      setPreview,
      busy,
      setBusy,
      isPending,
      tokenError,
      refetch,
    ],
  )

  if (preview)
    return (
      <styledEl.ReviewPanel aria-label="Review swap">
        <h2 ref={reviewHeading} tabIndex={-1}>
          Review swap
        </h2>
        {bottomContent()}
      </styledEl.ReviewPanel>
    )

  return (
    <TradeWidget
      inputCurrencyInfo={currencyInfo(Field.INPUT, selection.input, inputAmount)}
      outputCurrencyInfo={currencyInfo(Field.OUTPUT, selection.output, null)}
      actions={{
        onCurrencySelection: select,
        onSwitchTokens: switchTokens,
        onChangeRecipient: (value) => {
          if (!busy) setRecipient(value ?? '')
        },
        onUserInput: (field, value) => {
          if (field === Field.INPUT && !busy) setSelection((current) => ({ ...current, amount: value ?? '' }))
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
        inputsDisabled: busy,
        isMarketOrderWidget: true,
        displayChainName: true,
        inputTokenOptions: tokenOptions,
        outputTokenOptions: buyTokenOptions,
        priceImpact: { priceImpact: undefined, loading: false },
      }}
      disableOutput
      slots={{ currencyFields: AssetSwapFields, settingsWidget: null, selectTokenWidget: <></>, bottomContent }}
    />
  )
}

function currencyInfo(field: Field, currency: Currency | null, amount: CurrencyAmount<Currency> | null): CurrencyInfo {
  return {
    field,
    currency,
    amount,
    label: field === Field.INPUT ? 'You pay' : 'You receive',
    isIndependent: field === Field.INPUT,
    balance: null,
    fiatAmount: null,
    receiveAmountInfo: null,
  }
}
