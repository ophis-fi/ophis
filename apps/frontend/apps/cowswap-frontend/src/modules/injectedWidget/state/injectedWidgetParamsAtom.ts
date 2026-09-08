import { atom } from 'jotai'

import { CowSwapWidgetAppParams } from '@cowprotocol/widget-lib'

import { OPHIS_DEFAULT_APP_DATA_PARTNER_FEE, OPHIS_DEFAULT_PARTNER_FEE } from 'ophis/partnerFeeDefault'

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
 * A host widget's own `partnerFee` override does NOT replace this: it travels
 * the volumeFee pipeline (injectedWidgetPartnerFeeAtom -> volumeFeeAtom) and
 * resolveOphisPartnerFee APPENDS it as a second Volume entry, so every embedder
 * pays Ophis on top of what it charges its own users. Until 2026-09-08 the
 * override replaced the Ophis entry outright and an embedder (mtpelerin, 50 bps
 * to itself) routed $11.5k through the widget at 0 bps to Ophis.
 */
export const injectedWidgetAppDataPartnerFeeAtom = atom(() => OPHIS_DEFAULT_APP_DATA_PARTNER_FEE)
