import { useAtomValue } from 'jotai'

import { CurrencyAmount, Percent } from '@cowprotocol/currency'
import { useIsTradeUnsupported } from '@cowprotocol/tokens'

import { tradeFormValidationContextAtom, TradeFormValidation, validateTradeForm } from 'modules/tradeFormValidation'
import { useUsdAmount } from 'modules/usdAmount'

import { useConfirmPriceImpactWithoutFee } from 'common/hooks/useConfirmPriceImpactWithoutFee'

import { useSwapDerivedState } from './useSwapDerivedState'

import { DirectQuote } from '../services/wholeToken/router.service'

export function useDirectPriceImpact(quote: DirectQuote): {
  impact: Percent | undefined
  loading: boolean
  allowed: boolean
  confirm: () => Promise<boolean>
} {
  const { inputCurrency, outputCurrency } = useSwapDerivedState()
  const netInput = quote.netCost - quote.gasCost - quote.fees.reduce((sum, fee) => sum + fee.amount, 0n)
  const input = useUsdAmount(inputCurrency && CurrencyAmount.fromRawAmount(inputCurrency, netInput.toString()))
  const output = useUsdAmount(
    outputCurrency && CurrencyAmount.fromRawAmount(outputCurrency, quote.buyAmount.toString()),
  )
  const impact =
    input.value?.greaterThan(0) && output.value
      ? new Percent(input.value.subtract(output.value).quotient, input.value.quotient)
      : undefined
  const context = useAtomValue(tradeFormValidationContextAtom)
  const isSwapUnsupported = useIsTradeUnsupported(inputCurrency, outputCurrency)
  const loading = input.isLoading || output.isLoading
  const validations =
    context &&
    validateTradeForm({
      ...context,
      isSwapUnsupported,
      tradePriceImpact: { ...context.tradePriceImpact, priceImpact: impact, loading },
    })
  // Direct execution validates its own quote, actual balance and expiry.
  const allowed =
    !!context &&
    !validations?.some(
      (validation) =>
        ![
          TradeFormValidation.SellNativeToken,
          TradeFormValidation.QuoteErrors,
          TradeFormValidation.QuoteLoading,
          TradeFormValidation.QuoteExpired,
          TradeFormValidation.BalanceInsufficient,
        ].includes(validation),
    )
  const { confirmPriceImpactWithoutFee } = useConfirmPriceImpactWithoutFee(false)
  return { impact, loading, allowed, confirm: () => confirmPriceImpactWithoutFee(impact) }
}
