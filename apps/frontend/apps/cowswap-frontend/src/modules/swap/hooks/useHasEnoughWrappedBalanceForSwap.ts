import { useCurrencyAmountBalance } from '@cowprotocol/balances-and-allowances'
import { getWrappedToken } from '@cowprotocol/common-utils'
import { Currency, CurrencyAmount } from '@cowprotocol/currency'

import { useDerivedTradeState } from 'modules/trade'

export function useHasEnoughWrappedBalanceForSwap(amount?: CurrencyAmount<Currency> | null): boolean {
  const derivedTradeState = useDerivedTradeState()
  const { inputCurrency, inputCurrencyAmount } = derivedTradeState || {}

  const requiredAmount = amount === undefined ? inputCurrencyAmount : amount
  const wrappedBalance = useCurrencyAmountBalance(inputCurrency ? getWrappedToken(inputCurrency) : undefined)

  // is a native currency trade but wrapped token has enough balance
  return !!(wrappedBalance && requiredAmount && !wrappedBalance.lessThan(requiredAmount))
}
