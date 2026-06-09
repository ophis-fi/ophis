import { atom } from 'jotai'

import { CowSwapWidgetAppParams } from '@cowprotocol/widget-lib'

import { OPHIS_DEFAULT_APP_DATA_PARTNER_FEE, OPHIS_DEFAULT_PARTNER_FEE, OPHIS_FLAT_VOLUME_FEE_ENABLED } from 'ophis/partnerFeeDefault'

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
 * LEGACY Ophis price-improvement partner-fee shape, written directly into
 * appData.metadata.partnerFee when the flat-volume-fee flag is OFF (it is
 * ON in production since 2026-06-08, so this atom returns undefined there).
 * Bypasses the volumeFee pipeline (which only handles the `volumeBps`
 * shape) so the CIP-75 priceImprovementBps fallback works without
 * refactoring every fee-display component upstream.
 *
 * If a host widget overrides `partnerFee` in injectedWidgetParamsAtom,
 * we honour that override (volume-fee shape) and skip the Ophis on-chain
 * config so widget consumers retain their own fee behaviour.
 */
export const injectedWidgetAppDataPartnerFeeAtom = atom((get) => {
  const widgetFee = get(injectedWidgetParamsAtom).params.partnerFee
  // Suppress the direct price-improvement appData fee when EITHER (a) a host
  // widget overrides partnerFee, OR (b) the flat-volume-fee flag is on. In case
  // (b) the volumeFee pipeline (OPHIS_DEFAULT_PARTNER_FEE.bps) carries the
  // on-chain fee via AppDataUpdater's `ophisAppDataPartnerFee ?? volumeFee`,
  // so the displayed quote and the on-chain fee stay in lockstep (one source,
  // no hidden or double charge).
  if (widgetFee || OPHIS_FLAT_VOLUME_FEE_ENABLED) return undefined
  return OPHIS_DEFAULT_APP_DATA_PARTNER_FEE
})
