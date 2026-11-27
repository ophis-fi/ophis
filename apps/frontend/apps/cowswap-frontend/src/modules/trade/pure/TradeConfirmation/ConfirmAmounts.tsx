import { ReactNode } from 'react'

import { PriceImpact } from 'legacy/hooks/usePriceImpact'

import { CurrencyAmountPreview, CurrencyPreviewInfo } from 'common/pure/CurrencyAmountPreview'
import { SwapAmountPair } from 'common/pure/CurrencyAmountPreview/SwapAmountPair.pure'
import { getAreBridgeCurrencies } from 'common/utils/getAreBridgeCurrencies'

interface ConfirmAmountsProps {
  inputCurrencyInfo: CurrencyPreviewInfo
  outputCurrencyInfo: CurrencyPreviewInfo
  priceImpact: PriceImpact
}

export function ConfirmAmounts({ inputCurrencyInfo, outputCurrencyInfo, priceImpact }: ConfirmAmountsProps): ReactNode {
  const isBridging = getAreBridgeCurrencies(inputCurrencyInfo.amount?.currency, outputCurrencyInfo.amount?.currency)

  return (
    <SwapAmountPair
      sell={
        <CurrencyAmountPreview id="input-currency-preview" currencyInfo={inputCurrencyInfo} isBridging={isBridging} />
      }
      buy={
        <CurrencyAmountPreview
          id="output-currency-preview"
          currencyInfo={outputCurrencyInfo}
          priceImpactParams={priceImpact}
          isBridging={isBridging}
        />
      }
    />
  )
}
