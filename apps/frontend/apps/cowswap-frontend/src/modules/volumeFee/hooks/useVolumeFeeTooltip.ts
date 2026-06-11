import { useAtomValue } from 'jotai'
import { useMemo } from 'react'

import { t } from '@lingui/core/macro'

import { useInjectedWidgetParams } from 'modules/injectedWidget'

import { OPHIS_BOOSTED_VOLUME_BPS } from 'ophis/boostedTokens'

import { isBoostedTradeAtom } from '../state/volumeFeeAtom'
import { safeAppFeeAtom } from '../state/safeAppFeeAtom'

export interface VolumeFeeTooltip {
  content: string | undefined
  label: string
}

export function useVolumeFeeTooltip(): VolumeFeeTooltip {
  const safeAppFee = useAtomValue(safeAppFeeAtom)
  const isBoosted = useAtomValue(isBoostedTradeAtom)
  const widgetParams = useInjectedWidgetParams()

  return useMemo(() => {
    if (safeAppFee)
      return {
        content: t`The Safe App License Fee incurred here is charged by the Safe Foundation for the display of the app within their Safe Store. The fee is automatically calculated in this quote. Part of the fees will contribute to the Ophis treasury that supports the community.`,
        label: t`Safe App License Fee`,
      }

    // Boosted-token flagship (e.g. ALEPH): surface the "max rebate" tag at the fee
    // row whenever a boost is active, so the reduced rate is visible in the swap box.
    if (isBoosted)
      return {
        content: t`This token gets the maximum Ophis rebate: a reduced ${OPHIS_BOOSTED_VOLUME_BPS} bp fee on this swap, applied automatically regardless of your volume tier.`,
        label: t`⚡ Max rebate`,
      }

    return {
      content: widgetParams.content?.feeTooltipMarkdown,
      label: widgetParams.content?.feeLabel || t`Partner fee`,
    }
  }, [safeAppFee, isBoosted, widgetParams])
}
