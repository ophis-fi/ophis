import { atom } from 'jotai'

import { CowSwapWidgetAppParams } from '@cowprotocol/widget-lib'

import { GREG_DEFAULT_PARTNER_FEE } from 'greg/partnerFeeDefault'

export type WidgetParamsErrors = Partial<{ [key in keyof CowSwapWidgetAppParams]: string[] | undefined }>

export const injectedWidgetParamsAtom = atom<{ params: Partial<CowSwapWidgetAppParams>; errors: WidgetParamsErrors }>({
  params: {},
  errors: {},
})

export const injectedWidgetPartnerFeeAtom = atom((get) => {
  const widgetFee = get(injectedWidgetParamsAtom).params.partnerFee
  return widgetFee ?? GREG_DEFAULT_PARTNER_FEE
})
