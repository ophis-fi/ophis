/* eslint-disable @typescript-eslint/no-restricted-imports */ // TODO: Don't use 'modules' import
import { useCallback } from 'react'

import { USDC } from '@cowprotocol/common-const'
import { getWrappedToken, tryParseCurrencyAmount } from '@cowprotocol/common-utils'
import { SupportedChainId } from '@cowprotocol/cow-sdk'
import { Currency } from '@cowprotocol/currency'

import { useUsdPrice } from 'modules/usdAmount'

export function useConvertUsdToTokenValue(
  currency: Currency | null,
): (typedValue: string, isUsdMode: boolean) => string {
  // TODO: We need a ref for this:
  const currencyUsdcPrice = useUsdPrice(currency ? getWrappedToken(currency) : null)

  return useCallback(
    (typedValue: string, isUsdMode: boolean) => {
      // Defensive (2026-05-17): a UsdPriceState hydrated from a stale persisted
      // atom can have `.currency` undefined despite the static type, which
      // crashes the USD-mode input box on every keystroke. Treat it as
      // "no conversion available" instead.
      if (isUsdMode && currencyUsdcPrice?.price && currencyUsdcPrice.currency?.chainId != null) {
        const usdcToken = USDC[currencyUsdcPrice.currency.chainId as SupportedChainId]
        const usdAmount = tryParseCurrencyAmount(typedValue, usdcToken)

        const tokenAmount = currencyUsdcPrice.price.invert().quote(usdAmount)

        return tokenAmount.toExact()
      }

      return typedValue
    },
    [currencyUsdcPrice],
  )
}
