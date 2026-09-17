import { ReactNode } from 'react'

import { ETH_FLOW_SLIPPAGE_WARNING_THRESHOLD } from '@cowprotocol/common-const'
import { Percent } from '@cowprotocol/currency'
import { InlineBanner, StatusColorVariant } from '@cowprotocol/ui'

import { t } from '@lingui/core/macro'

import { LOW_TIER_FEE } from 'modules/tradeWidgetAddons'

import { PRICE_IMPACT_THRESHOLD } from 'common/constants/priceImpact'

import { DirectQuote, isMpsSell } from '../../services/wholeToken/router.service'

export function WholeTokenWarnings({
  quote,
  impact,
  loading,
}: {
  quote: DirectQuote
  impact: Percent | undefined
  loading: boolean
}): ReactNode {
  const selling = isMpsSell(quote)
  const fees = quote.fees.reduce((sum, fee) => sum + fee.amount, 0n)
  const approvalCost = selling
    ? (quote.approvalGas || 0n) * ((quote.maxFeePerGas + quote.maxPriorityFeePerGas) / 2n)
    : 0n
  const feesAndGas = fees + (selling ? quote.gasCost + approvalCost : (quote.gasCostInInput ?? quote.gasCost))
  const value = selling ? quote.buyAmount + fees : quote.netCost
  const costs = value > 0n ? new Percent(feesAndGas.toString(), value.toString()) : undefined
  const highImpact = impact && !impact.lessThan(PRICE_IMPACT_THRESHOLD.high)
  const impactPercent = impact?.toFixed(2) ?? ''
  const costPercent = costs?.toFixed(2) ?? ''
  const slippagePercent = quote.slippageBps / 100
  return (
    <>
      {!loading && !impact && (
        <InlineBanner bannerType={StatusColorVariant.Alert}>
          {t`Price impact is unavailable. Review the expected spend and receive amount carefully.`}
        </InlineBanner>
      )}
      {highImpact && (
        <InlineBanner bannerType={StatusColorVariant.Warning}>
          {t`Price impact is ${impactPercent}% based on the expected input, excluding fees and gas.`}
        </InlineBanner>
      )}
      {costs && !costs.lessThan(new Percent(LOW_TIER_FEE, 100)) && (
        <InlineBanner bannerType={StatusColorVariant.Warning}>
          {selling
            ? t`Fees and estimated gas are ${costPercent}% of the expected output value.`
            : t`Fees and estimated gas are ${costPercent}% of the expected total spend.`}
        </InlineBanner>
      )}
      {quote.slippageBps > ETH_FLOW_SLIPPAGE_WARNING_THRESHOLD[1] && (
        <InlineBanner bannerType={StatusColorVariant.Warning}>
          {selling
            ? t`High slippage tolerance: ${slippagePercent}%. The received amount can decrease to the quoted minimum.`
            : t`High slippage tolerance: ${slippagePercent}%. The input spent can increase up to the quoted maximum.`}
        </InlineBanner>
      )}
    </>
  )
}
