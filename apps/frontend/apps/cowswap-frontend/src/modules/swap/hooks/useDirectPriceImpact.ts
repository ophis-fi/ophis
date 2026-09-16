import { CurrencyAmount, Percent } from '@cowprotocol/currency'

import { useUsdAmount } from 'modules/usdAmount'

import { useConfirmPriceImpactWithoutFee } from 'common/hooks/useConfirmPriceImpactWithoutFee'

import { useSwapDerivedState } from './useSwapDerivedState'

import { DirectQuote } from '../services/wholeToken/router.service'

export function useDirectPriceImpact(quote: DirectQuote): {
  impact: Percent | undefined
  loading: boolean
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
  const { confirmPriceImpactWithoutFee } = useConfirmPriceImpactWithoutFee(false)
  return { impact, loading: input.isLoading || output.isLoading, confirm: () => confirmPriceImpactWithoutFee(impact) }
}
