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
import { useVolumeFee } from 'modules/volumeFee'

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
 * PARTNER FEE: resolved by `resolveBasketLegPartnerFee`, which is the swap
 * AppDataUpdater's fee decision extracted into a pure, tested function so a
 * basket leg and an equivalent single swap on the same chain cannot drift apart.
 * See `modules/appData/utils/resolveOphisPartnerFee.ts` for why each step
 * drops the fee. It is the same function the swap path uses.
 *
 * Before this was wired, every basket leg went out with no `partnerFee` at all,
 * so a 6-leg basket earned Ophis nothing.
 */
export function useBuildBasketLegAppData(slippageBips: number): BuildBasketLegAppDataFn {
  const { chainId } = useWalletInfo()
  const appCode = useAppCode()
  const appCodeWithWidgetMetadata = useAppCodeWidgetAware(appCode)
  const typedHooks = useAppDataHooks()
  const userConsent = useRwaConsentForAppData()
  const utm = useUtm()
  const volumeFee = useVolumeFee()
  const { savedCode: refCode } = useAtomValue(affiliateTraderSavedCodeAtom)

  const widgetPartnerFee = useAtomValue(injectedWidgetAppDataPartnerFeeAtom)
  const partnerFee = resolveOphisPartnerFee(widgetPartnerFee, volumeFee, chainId)

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
        utm,
        // Mirrors AppDataInfoUpdater, which passes its `volumeFee` prop through
        // to buildAppData's `partnerFee`. Without this every basket leg settles
        // at zero Ophis fee, so a 6-leg basket would earn nothing.
        partnerFee,
        // The leg's basket marker; buildAppData spreads this into metadata.ophisBasket.
        ophisBasket: marker,
      })
    },
    [appCodeWithWidgetMetadata, slippageBips, typedHooks, userConsent, refCode, utm, partnerFee],
  )
}
