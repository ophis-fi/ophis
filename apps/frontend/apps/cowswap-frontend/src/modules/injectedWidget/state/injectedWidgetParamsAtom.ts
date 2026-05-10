import { atom } from 'jotai'

import { CowSwapWidgetAppParams } from '@cowprotocol/widget-lib'

import { GREG_DEFAULT_APP_DATA_PARTNER_FEE, GREG_DEFAULT_PARTNER_FEE } from 'greg/partnerFeeDefault'

export type WidgetParamsErrors = Partial<{ [key in keyof CowSwapWidgetAppParams]: string[] | undefined }>

export const injectedWidgetParamsAtom = atom<{ params: Partial<CowSwapWidgetAppParams>; errors: WidgetParamsErrors }>({
  params: {},
  errors: {},
})

export const injectedWidgetPartnerFeeAtom = atom((get) => {
  const widgetFee = get(injectedWidgetParamsAtom).params.partnerFee
  return widgetFee ?? GREG_DEFAULT_PARTNER_FEE
})

/**
 * Ophis price-improvement partner-fee shape, written directly into
 * appData.metadata.partnerFee. Bypasses the volumeFee pipeline (which
 * only handles the `volumeBps` shape) so we can ship CIP-75's
 * priceImprovementBps mode without refactoring every fee-display
 * component upstream.
 *
 * If a host widget overrides `partnerFee` in injectedWidgetParamsAtom,
 * we honour that override (legacy volume-fee shape) and skip the
 * Ophis on-chain config so widget consumers retain their own fee
 * behaviour.
 */
export const injectedWidgetAppDataPartnerFeeAtom = atom((get) => {
  const widgetFee = get(injectedWidgetParamsAtom).params.partnerFee
  if (widgetFee) return undefined
  return GREG_DEFAULT_APP_DATA_PARTNER_FEE
})
