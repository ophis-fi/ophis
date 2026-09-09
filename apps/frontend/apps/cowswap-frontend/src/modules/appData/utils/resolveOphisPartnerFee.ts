import { areAddressesEqual } from '@cowprotocol/cow-sdk'

import {
  OPHIS_PARTNER_FEE_RECIPIENT,
  ophisAppDataPartnerFeeForChain,
  ophisVolumeOnlyFloorFee,
} from 'ophis/partnerFeeDefault'

import { shouldEmitOphisPartnerFee } from '../updater/shouldEmitOphisPartnerFee'

/**
 * True for a positive flat Volume fee paid to someone OTHER than Ophis: a host
 * widget's own `partnerFee` override, which reaches the resolver on the volumeFee
 * pipeline. The Ophis 1 bp base travels that same pipeline when the flat-fee
 * flag is on, and it is already inside the Ophis appData shape, so it must never
 * be appended a second time (the #1236 duplicated-partnerFee class).
 */
function isPositiveVolumeFee(fee: unknown): fee is { volumeBps: number; recipient: string } {
  if (typeof fee !== 'object' || fee === null) return false
  const { volumeBps, recipient } = fee as { volumeBps?: unknown; recipient?: unknown }
  return typeof volumeBps === 'number' && volumeBps > 0 && typeof recipient === 'string'
}

function isThirdPartyVolumeFee(fee: unknown): fee is { volumeBps: number; recipient: string } {
  return isPositiveVolumeFee(fee) && !areAddressesEqual(fee.recipient, OPHIS_PARTNER_FEE_RECIPIENT)
}

/**
 * A host fee paid TO Ophis: the published `@ophis/widget-react` wrapper pins the
 * recipient to the Ophis Safe on every explicit `partnerFee` and documents that
 * "the iframe then treats the explicit volume override as authoritative"
 * (packages/widget-react/src/defaults.ts). Keep that contract: the explicit
 * Volume fee IS the Ophis fee for that order, nothing is stacked on it.
 */
function isOphisRecipientHostFee(fee: unknown): fee is { volumeBps: number; recipient: string } {
  return isPositiveVolumeFee(fee) && areAddressesEqual(fee.recipient, OPHIS_PARTNER_FEE_RECIPIENT)
}

/**
 * Resolve the `metadata.partnerFee` an order must carry, from the widget
 * override and the volumeFee pipeline.
 *
 * THE single implementation of this decision. `AppDataUpdater` calls it for
 * ordinary swaps and `useBuildBasketLegAppData` calls it for basket legs, so
 * the two cannot drift: a basket leg is an ordinary CoW order and must arrive
 * at the same answer for the same chain, or a basket would be cheaper than the
 * equivalent single swaps.
 *
 * Order matters and each step drops the fee for a different reason:
 *
 *   1. `shouldEmitOphisPartnerFee(chainId)` gates on chain SUPPORT, i.e. is the
 *      chain in the per-network recipient map at all. An unsupported chain, or
 *      no connected chain, emits no Ophis fee.
 *   2. `ophisAppDataPartnerFeeForChain` suppresses the price-improvement shape
 *      on chains that mandate the CIP-75 Volume policy and reject PI at
 *      ingress. Those chains carry their floor fee through the volumeFee
 *      pipeline instead, so suppressing here is what makes step 3 correct
 *      rather than a silent downgrade.
 *   3. Falling back to `volumeFee` picks up that pipeline, which is also the
 *      path a widget consumer's own volumeBps override arrives on.
 *   4. On a chain where the Ophis shape IS emitted, and ONLY when the host of an
 *      injected widget supplied its own `partnerFee` (`hostFee`), a THIRD-PARTY fee
 *      is STACKED with the Ophis entries, never substituted for them: the
 *      embedder charges its users whatever it likes and Ophis still earns the
 *      1 bp base plus capped improvement on the same order. The rebate indexer
 *      already reads the stacked shape (Ophis entry + integrator own-fee entry).
 *
 * Exported from the `modules/appData` barrel: other modules must consume it
 * from there, never by reaching into `updater/`.
 */
export function resolveOphisPartnerFee<TWidgetFee, TVolumeFee>(
  widgetPartnerFee: TWidgetFee | undefined,
  volumeFee: TVolumeFee | undefined,
  chainId: number | undefined,
  isStablePair = false,
  hostFee?: 'ophis' | 'third-party',
): TWidgetFee | TVolumeFee | undefined {
  // Two type parameters, not one: the widget fee is a price-improvement shape
  // and the volume fee is a Volume shape, so collapsing them to a single `T`
  // makes the two arguments fight and the call site stops compiling. The union
  // return mirrors what `??` produces at the swap call site.
  const gated = shouldEmitOphisPartnerFee(chainId) ? widgetPartnerFee : undefined
  const ophis = ophisAppDataPartnerFeeForChain(gated, chainId, isStablePair)
  if (ophis === undefined) {
    return resolveVolumeOnlyPartnerFee(volumeFee, chainId, isStablePair, hostFee)
  }
  if (!hostFee) return ophis

  // Stack AFTER the per-chain gate: that gate swaps in the stable-pair variant by
  // reference equality, so a new array must only be built here. The host entry goes
  // FIRST to preserve the host fee within the aggregate budget:
  //  - CoW's autopilot applies partner-fee policies in array order against a 100 bps
  //    aggregate budget and counts a PI policy's maxVolumeBps against it up front, so
  //    [Ophis 1, PI cap 99, host 50] would clamp the host to ZERO on volatile pairs.
  //    [host 50, Ophis 1, PI] keeps the host whole and lets CoW clamp the Ophis PI
  //    cap to the remainder (49 volatile; untouched on stable, cap 20).
  // The result is the Ophis shape (an array of entries) plus one Volume entry, hence
  // the TWidgetFee cast.
  // `hostFee` is the provenance gate: the volumeFee pipeline also carries the Safe
  // App licence fee (non-Ophis recipient, no widget), which must keep today's
  // behaviour (the Ophis shape wins) rather than be mistaken for a host fee.
  if (Array.isArray(ophis) && isThirdPartyVolumeFee(volumeFee)) {
    return [volumeFee, ...ophis] as unknown as TWidgetFee
  }
  // Wrapper path (recipient = Ophis): the explicit override stays authoritative,
  // exactly as before this change, so first-party embeds keep their configured fee
  // -- including an explicit `bps: 0`, which the pipeline resolves to undefined and
  // which means "free" for that embed. A third-party zero gets no such ride: it
  // falls through to the Ophis policy below.
  if (isOphisRecipientHostFee(volumeFee)) return volumeFee
  if (hostFee === 'ophis' && volumeFee === undefined) return undefined
  return ophis
}

function resolveVolumeOnlyPartnerFee<TVolumeFee>(
  volumeFee: TVolumeFee | undefined,
  chainId: number | undefined,
  isStablePair: boolean,
  hostFee: 'ophis' | 'third-party' | undefined,
): TVolumeFee | undefined {
  const floor = hostFee === 'third-party' && ophisVolumeOnlyFloorFee(chainId, isStablePair)
  if (!floor) return volumeFee
  // The backend floors present entries only, so zero-host routes must still emit it.
  if (isThirdPartyVolumeFee(volumeFee)) return [volumeFee, floor] as unknown as TVolumeFee
  return volumeFee ?? (floor as unknown as TVolumeFee)
}
