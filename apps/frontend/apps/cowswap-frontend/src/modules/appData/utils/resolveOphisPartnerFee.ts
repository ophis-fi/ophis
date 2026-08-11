import { ophisAppDataPartnerFeeForChain } from 'ophis/partnerFeeDefault'

import { shouldEmitOphisPartnerFee } from '../updater/shouldEmitOphisPartnerFee'

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
 *
 * Exported from the `modules/appData` barrel: other modules must consume it
 * from there, never by reaching into `updater/`.
 */
export function resolveOphisPartnerFee<TWidgetFee, TVolumeFee>(
  widgetPartnerFee: TWidgetFee | undefined,
  volumeFee: TVolumeFee | undefined,
  chainId: number | undefined,
  isStablePair = false,
): TWidgetFee | TVolumeFee | undefined {
  // Two type parameters, not one: the widget fee is a price-improvement shape
  // and the volume fee is a Volume shape, so collapsing them to a single `T`
  // makes the two arguments fight and the call site stops compiling. The union
  // return mirrors what `??` produces at the swap call site.
  const gated = shouldEmitOphisPartnerFee(chainId) ? widgetPartnerFee : undefined
  return ophisAppDataPartnerFeeForChain(gated, chainId, isStablePair) ?? volumeFee
}
