import { useCallback } from 'react'

import { useAtomValue } from 'jotai'

import { useWalletInfo } from '@cowprotocol/wallet'

import { OphisBasketTag } from 'ophis/basketMetadata'

import { affiliateTraderSavedCodeAtom } from 'modules/affiliate'
import { AppDataInfo, buildAppData, resolveOphisPartnerFee } from 'modules/appData'
import { useAppCode, useAppDataHooks } from 'modules/appData/hooks'
import { useRwaConsentForAppData } from 'modules/appData/hooks/useRwaConsentForAppData'
import { injectedWidgetAppDataPartnerFeeAtom } from 'modules/injectedWidget'
import { useAppCodeWidgetAware } from 'modules/injectedWidget/hooks/useAppCodeWidgetAware'
import { useUtm } from 'modules/utm'

import { useBasketLegPartnerFee } from './useBasketLegPartnerFee'
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
 * PARTNER FEE: resolved from THE LEG'S OWN PAIR, not from the swap form.
 *
 * Two layers, both shared with the swap path so they cannot drift:
 *   - `useBasketLegPartnerFee` resolves the Volume fee for this leg's sell/buy
 *     pair (stable, boosted and correlated rates are pair properties).
 *   - `resolveOphisPartnerFee` then applies the chain gate, which is the same
 *     function `AppDataUpdater` uses.
 *
 * The `leg` argument is load-bearing. An earlier version of this hook discarded
 * it and resolved one fee from `useVolumeFee()`, i.e. from whatever pair the
 * swap form happened to hold, then applied that to every leg. In a mixed basket
 * that charges a stable leg the standard rate, or a non-stable leg 1 bp, which
 * the backend fee floor rejects at ingress.
 *
 * Before any of this was wired, every basket leg went out with no `partnerFee`
 * at all, so a 6-leg basket earned Ophis nothing.
 */
export function useBuildBasketLegAppData(slippageBips: number): BuildBasketLegAppDataFn {
  const { chainId } = useWalletInfo()
  const appCode = useAppCode()
  const appCodeWithWidgetMetadata = useAppCodeWidgetAware(appCode)
  const typedHooks = useAppDataHooks()
  const userConsent = useRwaConsentForAppData()
  const utm = useUtm()
  const { savedCode: refCode } = useAtomValue(affiliateTraderSavedCodeAtom)

  const resolveLegPartnerFee = useBasketLegPartnerFee()
  const widgetPartnerFee = useAtomValue(injectedWidgetAppDataPartnerFeeAtom)

  return useCallback(
    async (leg, marker: OphisBasketTag): Promise<AppDataInfo> => {
      if (!appCodeWithWidgetMetadata) {
        throw new Error('basket: appData metadata is not ready yet (no connected wallet context)')
      }
      const { appCode: code, environment, widget } = appCodeWithWidgetMetadata
      const partnerFee = resolveOphisPartnerFee(widgetPartnerFee, resolveLegPartnerFee(leg), chainId)

      return buildAppData({
        appCode: code,
        environment,
        slippageBips,
        orderClass: 'market',
        typedHooks,
        widget,
        userConsent,
        refCode,
        utm,
        // Mirrors AppDataInfoUpdater, which passes its `volumeFee` prop through
        // to buildAppData's `partnerFee`.
        partnerFee,
        // The leg's basket marker; buildAppData spreads this into metadata.ophisBasket.
        ophisBasket: marker,
      })
    },
    [
      appCodeWithWidgetMetadata,
      slippageBips,
      typedHooks,
      userConsent,
      refCode,
      utm,
      widgetPartnerFee,
      resolveLegPartnerFee,
      chainId,
    ],
  )
}
