import { atom } from 'jotai'

import { areAddressesEqual } from '@cowprotocol/cow-sdk'
import { CowSwapWidgetAppParams, resolveFlexibleConfig, TradeType } from '@cowprotocol/widget-lib'

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
 * A host widget's own `partnerFee` override does NOT replace this: it travels
 * the volumeFee pipeline (injectedWidgetPartnerFeeAtom -> volumeFeeAtom) and
 * resolveOphisPartnerFee APPENDS it as a second Volume entry, so every embedder
 * pays Ophis on top of what it charges its own users. Until 2026-09-08 the
 * override replaced the Ophis entry outright and an embedder (mtpelerin, 50 bps
 * to itself) routed $11.5k through the widget at 0 bps to Ophis.
 */
export const injectedWidgetAppDataPartnerFeeAtom = atom(() => OPHIS_DEFAULT_APP_DATA_PARTNER_FEE)

/**
 * Provenance of a host fee, for resolveOphisPartnerFee, resolved PER ROUTE (chain +
 * trade type) because both `bps` and `recipient` are FlexibleConfigs that may differ
 * across networks: a wrapper embed on one chain next to a third-party fee on another
 * is a valid configuration.
 *  - undefined: the host of an injected widget set no `partnerFee`. The pipeline may
 *    still carry the Safe App licence fee (non-Ophis recipient, no widget), which
 *    must keep today's behaviour and never be treated as a host override.
 *  - 'ophis': the recipient on this route is the Ophis Safe. That is the published
 *    `@ophis/widget-react` wrapper, which pins the recipient and documents the
 *    explicit override (including `bps: 0`, i.e. free) as authoritative.
 *  - 'third-party': the host charges its own recipient on this route (a raw embed);
 *    its fee is STACKED with the Ophis policy, and a zero never buys a free ride.
 * Pure so the two atoms in modules/volumeFee (form route + basket) share it.
 */
export type InjectedWidgetHostFeeKind = 'ophis' | 'third-party'

export function classifyInjectedWidgetHostFee(
  rawPartnerFee: CowSwapWidgetAppParams['partnerFee'] | undefined,
  chainId: number,
  widgetTradeType: TradeType,
): InjectedWidgetHostFeeKind | undefined {
  if (!rawPartnerFee) return undefined
  const recipient = resolveFlexibleConfig(rawPartnerFee.recipient, chainId, widgetTradeType)
  return typeof recipient === 'string' && areAddressesEqual(recipient, OPHIS_PARTNER_FEE_RECIPIENT)
    ? 'ophis'
    : 'third-party'
}
