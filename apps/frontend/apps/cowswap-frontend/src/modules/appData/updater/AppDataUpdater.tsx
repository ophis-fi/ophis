import { useAtomValue } from 'jotai'
import React from 'react'

import { useWalletInfo } from '@cowprotocol/wallet'

import { affiliateTraderSavedCodeAtom, useIsRefCodeExpired } from 'modules/affiliate'
import { injectedWidgetAppDataPartnerFeeAtom } from 'modules/injectedWidget'
import { useAppCodeWidgetAware } from 'modules/injectedWidget/hooks/useAppCodeWidgetAware'
import { useReplacedOrderUid } from 'modules/trade/state/alternativeOrder'
import { useUtm } from 'modules/utm'
import { useVolumeFee } from 'modules/volumeFee'

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
  const ophisAppDataPartnerFee = shouldEmitOphisPartnerFee(chainId) ? ophisAppDataPartnerFeeRaw : undefined
  const replacedOrderUid = useReplacedOrderUid()
  const userConsent = useRwaConsentForAppData()
  const { savedCode: refCode } = useAtomValue(affiliateTraderSavedCodeAtom)
  const isRefCodeExpired = useIsRefCodeExpired()

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
      refCode={isRefCodeExpired ? undefined : refCode}
    />
  )
})

const AppDataUpdaterMemo = React.memo((params: UseAppDataParams) => (
  <>
    <AppDataHooksUpdater />
    <AppDataInfoUpdater {...params} />
  </>
))
