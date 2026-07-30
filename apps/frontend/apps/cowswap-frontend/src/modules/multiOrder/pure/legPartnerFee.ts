import { ophisAppDataPartnerFeeForChain } from 'ophis/partnerFeeDefault'

import { shouldEmitOphisPartnerFee } from 'modules/appData/updater/shouldEmitOphisPartnerFee'

/**
 * Resolve the `metadata.partnerFee` a single basket leg must carry.
 *
 * This is the swap path's fee decision, extracted so it can be asserted rather
 * than re-typed. `AppDataUpdater` performs exactly these three steps inline and
 * then passes the result to `AppDataInfoUpdater` as `volumeFee`, which hands it
 * to `buildAppData` as `partnerFee`. A basket leg is an ordinary CoW order, so
 * it must arrive at the same answer for the same chain, or a basket would be
 * cheaper than the equivalent single swaps and Ophis would earn nothing on it.
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
 * Keep in lockstep with `modules/appData/updater/AppDataUpdater.tsx`.
 */
export function resolveBasketLegPartnerFee<TWidgetFee, TVolumeFee>(
  widgetPartnerFee: TWidgetFee | undefined,
  volumeFee: TVolumeFee | undefined,
  chainId: number | undefined,
): TWidgetFee | TVolumeFee | undefined {
  // Two type parameters, not one: the widget fee is a price-improvement shape
  // and the volume fee is a Volume shape, so collapsing them to a single `T`
  // makes the two arguments fight and the call site stops compiling. The union
  // return mirrors what `??` produces at the swap call site.
  const gated = shouldEmitOphisPartnerFee(chainId) ? widgetPartnerFee : undefined
  return ophisAppDataPartnerFeeForChain(gated, chainId) ?? volumeFee
}
