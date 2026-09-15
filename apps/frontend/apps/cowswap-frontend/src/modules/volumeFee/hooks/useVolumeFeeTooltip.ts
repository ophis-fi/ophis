import { useAtomValue } from 'jotai'
import { useMemo } from 'react'

import { t } from '@lingui/core/macro'
import { OPHIS_BOOSTED_VOLUME_BPS } from 'ophis/boostedTokens'
import { OPHIS_FLAT_VOLUME_FEE_ENABLED } from 'ophis/partnerFeeDefault'

import { useInjectedWidgetParams } from 'modules/injectedWidget'

import { safeAppFeeAtom } from '../state/safeAppFeeAtom'
import { hostFeeKindAtom, isBoostedTradeAtom, widgetPartnerFeeAtom } from '../state/volumeFeeAtom'

export interface VolumeFeeTooltip {
  content: string | undefined
  label: string
}

export function useVolumeFeeTooltip(): VolumeFeeTooltip {
  const safeAppFee = useAtomValue(safeAppFeeAtom)
  const isBoosted = useAtomValue(isBoostedTradeAtom)
  const { content } = useInjectedWidgetParams()
  const { feeLabel, feeTooltipMarkdown } = content ?? {}
  const hostFee = useAtomValue(hostFeeKindAtom)
  const widgetPartnerFee = useAtomValue(widgetPartnerFeeAtom)

  const hasOphisBoost = OPHIS_FLAT_VOLUME_FEE_ENABLED && isBoosted && hostFee !== 'third-party'

  return useMemo(() => {
    // Boosted-token flagship (e.g. ALEPH): the boosted fee wins over a Safe-App fee in
    // volumeFeeAtom when the flat-fee flag is on, so the "max rebate" tag takes precedence
    // here too. Gated on the same flag so the tag only shows when the boost actually applies.
    if (hasOphisBoost)
      return {
        content: t`This token gets the maximum Ophis rebate: a reduced ${OPHIS_BOOSTED_VOLUME_BPS} bp fee on this swap, applied automatically regardless of your volume tier.`,
        label: t`⚡ Max rebate`,
      }

    if (safeAppFee)
      return {
        content: t`The Safe App License Fee incurred here is charged by the Safe Foundation for the display of the app within their Safe Store. The fee is automatically calculated in this quote. Part of the fees will contribute to the Ophis treasury that supports the community.`,
        label: t`Safe App License Fee`,
      }

    // A third-party host fee is STACKED with the Ophis fee (resolveOphisPartnerFee),
    // and the row shows their combined rate, so the host's custom label/tooltip must not
    // present the combined rate as the host's own charge. The wrapper path (recipient
    // = Ophis) keeps the host's wording: there the explicit fee IS the whole fee.
    if (hostFee === 'third-party') {
      if (!widgetPartnerFee || widgetPartnerFee.volumeBps <= 0) {
        return {
          content: t`The Ophis fee is applied only if the trade is executed.`,
          label: t`Ophis fee`,
        }
      }
      const hostLabel = feeLabel || t`partner fee`
      return {
        content: t`Includes the ${hostLabel} charged by this app and the Ophis fee, applied only if the trade is executed.`,
        label: t`Fees`,
      }
    }

    return {
      content: feeTooltipMarkdown,
      label: feeLabel || t`Partner fee`,
    }
  }, [safeAppFee, hasOphisBoost, feeLabel, feeTooltipMarkdown, hostFee, widgetPartnerFee])
}
