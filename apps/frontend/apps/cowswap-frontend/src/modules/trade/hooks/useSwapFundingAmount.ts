import { useMemo } from 'react'

import { getWrappedToken } from '@cowprotocol/common-utils'
import { areAddressesEqual, OrderKind } from '@cowprotocol/cow-sdk'
import { Currency, CurrencyAmount } from '@cowprotocol/currency'
import { useWalletInfo } from '@cowprotocol/wallet'

import { getIsFastQuote, isQuoteExpired, useTradeQuote } from 'modules/tradeQuote'

import { useAmountsToSignFromQuote } from './useAmountsToSignFromQuote'
import { useDerivedTradeState } from './useDerivedTradeState'
import { useGetReceiveAmountInfo } from './useGetReceiveAmountInfo'
import { useIsWrapOrUnwrap } from './useIsWrapOrUnwrap'

import { TradeType } from '../types'

// Validate the signed BUY cap; wrapping can also reserve approval headroom.
export function useSwapFundingAmount(includeApprovalBuffer = false): CurrencyAmount<Currency> | null {
  const { inputCurrency, outputCurrencyAmount, inputCurrencyAmount, orderKind, tradeType } =
    useDerivedTradeState() || {}
  const { maximumSendSellAmount } = useAmountsToSignFromQuote() || {}
  const { amountsToSign } = useGetReceiveAmountInfo() || {}
  const sellAmount = includeApprovalBuffer ? maximumSendSellAmount : amountsToSign?.sellAmount
  const { account } = useWalletInfo()
  const isWrap = useIsWrapOrUnwrap()
  const isBuySwap = [
    orderKind === OrderKind.BUY,
    tradeType === TradeType.SWAP,
    !isWrap,
    inputCurrency?.chainId === outputCurrencyAmount?.currency.chainId,
  ].every(Boolean)
  const tradeQuote = useTradeQuote()
  const { quote } = tradeQuote
  const order = quote?.quoteResults.quoteResponse.quote
  return useMemo(() => {
    if (!inputCurrency || !isBuySwap) {
      return inputCurrencyAmount || null
    }
    if (!sellAmount || !outputCurrencyAmount || !order || !quote) return null
    const matches = [
      order.kind === OrderKind.BUY,
      !tradeQuote.isLoading,
      !tradeQuote.error,
      !getIsFastQuote(tradeQuote.fetchParams),
      !isQuoteExpired(tradeQuote),
      !account || areAddressesEqual(quote.quoteResults.tradeParameters.owner, account),
      Number(quote.quoteResults.orderTypedData.domain.chainId) === inputCurrency.chainId,
      areAddressesEqual(order.sellToken, getWrappedToken(inputCurrency).address),
      areAddressesEqual(order.buyToken, getWrappedToken(outputCurrencyAmount.currency).address),
      order.buyAmount === outputCurrencyAmount.quotient.toString(),
      sellAmount.currency.chainId === inputCurrency.chainId,
    ].every(Boolean)
    return matches ? CurrencyAmount.fromRawAmount(inputCurrency, sellAmount.quotient) : null
  }, [
    inputCurrency,
    inputCurrencyAmount,
    isBuySwap,
    sellAmount,
    outputCurrencyAmount,
    order,
    tradeQuote,
    quote,
    account,
  ])
}
