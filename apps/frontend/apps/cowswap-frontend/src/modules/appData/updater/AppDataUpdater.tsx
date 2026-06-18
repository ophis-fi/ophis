import { useAtomValue } from 'jotai'
import React from 'react'

import { useWalletInfo } from '@cowprotocol/wallet'

import { affiliateTraderSavedCodeAtom } from 'modules/affiliate'
import { injectedWidgetAppDataPartnerFeeAtom } from 'modules/injectedWidget'
import { useAppCodeWidgetAware } from 'modules/injectedWidget/hooks/useAppCodeWidgetAware'
import { useReplacedOrderUid } from 'modules/trade/state/alternativeOrder'
import { useUtm } from 'modules/utm'
import { useVolumeFee } from 'modules/volumeFee'

import { ophisAppDataPartnerFeeForChain } from 'ophis/partnerFeeDefault'

import { AppDataHooksUpdater } from './AppDataHooksUpdater'
import { AppDataInfoUpdater, UseAppDataParams } from './AppDataInfoUpdater'
import { shouldEmitOphisPartnerFee } from './shouldEmitOphisPartnerFee'

import { useAppCode, useAppDataHooks } from '../hooks'
import { useRwaConsentForAppData } from '../hooks/useRwaConsentForAppData'
import { AppDataOrderClass } from '../types'

interface AppDataUpdaterProps {
  slippageBips: number
  isSmartSlippage?: boolean
  orderClass: AppDataOrderClass
}

export const AppDataUpdater = React.memo(({ slippageBips, isSmartSlippage, orderClass }: AppDataUpdaterProps) => {
  const { chainId } = useWalletInfo()

  const appCode = useAppCode()
  const utm = useUtm()
  const typedHooks = useAppDataHooks()
  const appCodeWithWidgetMetadata = useAppCodeWidgetAware(appCode)
  const volumeFee = useVolumeFee()
  // Ophis: price-improvement partnerFee shape (CIP-75) takes
  // precedence over the volumeFee pipeline when set. The volumeFee
  // path stays for widget consumers that override partnerFee with
  // their own volumeBps shape via injectedWidgetParamsAtom.
  //
  // Chain-gate: emit the Ophis partner fee on every chain the frontend
  // serves (restored all-chain model 2026-05-27). shouldEmitOphisPartnerFee
  // gates on chain SUPPORT (membership in the per-network recipient map),
  // not the recipient value; the recipient itself is the Ophis Safe via
  // partnerFeeDefault.ts.
  const ophisAppDataPartnerFeeRaw = useAtomValue(injectedWidgetAppDataPartnerFeeAtom)
  const ophisAppDataPartnerFeeGated = shouldEmitOphisPartnerFee(chainId) ? ophisAppDataPartnerFeeRaw : undefined
  // OP (and any future self-hosted chain) mandates the CIP-75 Volume policy: the
  // backend rejects the price-improvement fallback at ingress AND lets an absent
  // fee ride free. So on those chains ophisAppDataPartnerFeeForChain emits a
  // floor Volume fee when the PI fallback would apply (flat-volume flag OFF), or
  // undefined when the flag is ON (the volumeFee pipeline below carries the
  // proper 10/1 bps). It never emits the PI shape or nothing on OP.
  const ophisAppDataPartnerFee = ophisAppDataPartnerFeeForChain(ophisAppDataPartnerFeeGated, chainId)
  const replacedOrderUid = useReplacedOrderUid()
  const userConsent = useRwaConsentForAppData()
  const { savedCode: refCode } = useAtomValue(affiliateTraderSavedCodeAtom)

  if (!chainId) return null

  return (
    <AppDataUpdaterMemo
      appCodeWithWidgetMetadata={appCodeWithWidgetMetadata}
      slippageBips={slippageBips}
      isSmartSlippage={isSmartSlippage}
      orderClass={orderClass}
      utm={utm}
      typedHooks={typedHooks}
      volumeFee={ophisAppDataPartnerFee ?? volumeFee}
      replacedOrderUid={replacedOrderUid}
      userConsent={userConsent}
      refCode={refCode}
    />
  )
})

const AppDataUpdaterMemo = React.memo((params: UseAppDataParams) => (
  <>
    <AppDataHooksUpdater />
    <AppDataInfoUpdater {...params} />
  </>
))
