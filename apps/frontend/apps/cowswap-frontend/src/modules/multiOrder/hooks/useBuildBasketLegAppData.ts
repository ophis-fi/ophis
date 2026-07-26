import { useCallback } from 'react'

import { useAtomValue } from 'jotai'

import { OphisBasketTag } from 'ophis/basketMetadata'

import { affiliateTraderSavedCodeAtom } from 'modules/affiliate'
import { AppDataInfo, buildAppData } from 'modules/appData'
import { useAppCode, useAppDataHooks } from 'modules/appData/hooks'
import { useRwaConsentForAppData } from 'modules/appData/hooks/useRwaConsentForAppData'
import { useAppCodeWidgetAware } from 'modules/injectedWidget/hooks/useAppCodeWidgetAware'

import { BuildBasketLegAppDataFn } from './useBasketPlacement'

/**
 * The concrete per-leg appData builder: gathers the same appData params the
 * normal-swap AppDataUpdater assembles (appCode + widget metadata, order class,
 * typed hooks, RWA consent, saved referral code) and MERGES the leg's basket
 * marker at `ophisBasket`, which buildAppData spreads into
 * `metadata.ophisBasket`. This is the call site that was missing: with it, every
 * placed basket leg's submitted appData carries { id, leg, legs }, so the rebate
 * indexer's basket_id populates and the orders-table badge can group the legs.
 *
 * `orderClass` is fixed to 'market' (basket legs are market orders). Returns a
 * function keyed to the current wallet's appData context.
 *
 * NOTE: the exact Ophis partner-fee gating (injectedWidgetAppDataPartnerFeeAtom
 * / shouldEmitOphisPartnerFee / ophisAppDataPartnerFeeForChain, as the swap
 * AppDataUpdater applies) and utm are intentionally left for the production route
 * wiring (owner decision) rather than approximated here; omitting them still
 * yields a valid Ophis order appData carrying the basket marker.
 */
export function useBuildBasketLegAppData(slippageBips: number): BuildBasketLegAppDataFn {
  const appCode = useAppCode()
  const appCodeWithWidgetMetadata = useAppCodeWidgetAware(appCode)
  const typedHooks = useAppDataHooks()
  const userConsent = useRwaConsentForAppData()
  const { savedCode: refCode } = useAtomValue(affiliateTraderSavedCodeAtom)

  return useCallback(
    async (_leg, marker: OphisBasketTag): Promise<AppDataInfo> => {
      if (!appCodeWithWidgetMetadata) {
        throw new Error('basket: appData metadata is not ready yet (no connected wallet context)')
      }
      const { appCode: code, environment, widget } = appCodeWithWidgetMetadata
      return buildAppData({
        appCode: code,
        environment,
        slippageBips,
        orderClass: 'market',
        typedHooks,
        widget,
        userConsent,
        refCode,
        // The leg's basket marker; buildAppData spreads this into metadata.ophisBasket.
        ophisBasket: marker,
      })
    },
    [appCodeWithWidgetMetadata, slippageBips, typedHooks, userConsent, refCode],
  )
}
