import { atom } from 'jotai'

import { CowSwapWidgetAppParams } from '@cowprotocol/widget-lib'

import {
  OPHIS_DEFAULT_APP_DATA_PARTNER_FEE,
  OPHIS_DEFAULT_PARTNER_FEE,
  OPHIS_PARTNER_FEE_RECIPIENT,
} from 'ophis/partnerFeeDefault'

export type WidgetParamsErrors = Partial<{ [key in keyof CowSwapWidgetAppParams]: string[] | undefined }>

export const injectedWidgetParamsAtom = atom<{ params: Partial<CowSwapWidgetAppParams>; errors: WidgetParamsErrors }>({
  params: {},
  errors: {},
})

export const injectedWidgetPartnerFeeAtom = atom((get) => {
  const widgetFee = get(injectedWidgetParamsAtom).params.partnerFee
  return widgetFee ?? OPHIS_DEFAULT_PARTNER_FEE
})

/**
 * Ophis's hosted all-chain policy, written directly into
 * appData.metadata.partnerFee. It bypasses the volumeFee pipeline because that
 * pipeline can represent the 1 bp base but not the capped improvement entry.
 *
 * If a host widget overrides `partnerFee` in injectedWidgetParamsAtom,
 * we honour that override (volume-fee shape) and skip the Ophis on-chain
 * config so widget consumers retain their own fee behaviour.
 */
export const injectedWidgetAppDataPartnerFeeAtom = atom((get) => {
  const widgetFee = get(injectedWidgetParamsAtom).params.partnerFee
  // A non-Ophis widget override remains authoritative. The official
  // @ophis/widget's canonical recipient selects the complete Ophis policy
  // (base + improvement) instead of accidentally stripping the improvement.
  if (widgetFee && widgetFee.recipient !== OPHIS_PARTNER_FEE_RECIPIENT) return undefined
  return OPHIS_DEFAULT_APP_DATA_PARTNER_FEE
})
