import { useMemo } from 'react'

import { bpsToPercent } from '@cowprotocol/common-utils'
import { Currency, CurrencyAmount } from '@cowprotocol/currency'

import { useAppDataVolumeFeeBps } from 'modules/appData'
import { useDerivedTradeState } from 'modules/trade'
import { useVolumeFee } from 'modules/volumeFee'

export function useLimitOrderPartnerFeeAmount(): CurrencyAmount<Currency> | null {
  const state = useDerivedTradeState()
  // Disclose what the order signs: every stacked Volume entry, not the pipeline's one.
  const appDataVolumeBps = useAppDataVolumeFeeBps()
  const pipelineVolumeBps = useVolumeFee()?.volumeBps
  const volumeBps = appDataVolumeBps ?? pipelineVolumeBps
  const outputCurrencyAmount = state?.outputCurrencyAmount

  return useMemo(() => {
    if (!outputCurrencyAmount) return null

    return !!volumeBps && volumeBps > 0
      ? outputCurrencyAmount.multiply(bpsToPercent(volumeBps))
      : CurrencyAmount.fromRawAmount(outputCurrencyAmount.currency, 0)
  }, [outputCurrencyAmount, volumeBps])
}
