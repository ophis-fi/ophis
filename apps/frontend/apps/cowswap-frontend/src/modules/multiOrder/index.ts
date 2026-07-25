// Public API of the multiOrder (basket / "ophis-multi-order") module. Import
// basket features via this barrel only (per the module-boundary convention).

export type {
  BasketDraft,
  BasketLeg,
  BasketLegStatus,
  BasketLegQuote,
  BasketTier,
} from './types'
export { CANCELLABLE_LEG_STATUSES } from './types'

export {
  basketCompositionAtom,
  basketDraftAtom,
  resetBasketAtom,
  updateBasketLegAtom,
  cancellableBasketLegsAtom,
  type BasketCompositionState,
  type UpdateBasketLegParams,
} from './state/multiOrder.atoms'

export { useBasketDecomposition, type UseBasketDecompositionResult } from './hooks/useBasketDecomposition'
export {
  useBasketQuotes,
  type BasketQuoteFn,
  type BasketLegQuoteRequest,
  type UseBasketQuotesResult,
} from './hooks/useBasketQuotes'
export { useBatchPresign, type UseBatchPresignResult } from './hooks/useBatchPresign'
export {
  useBasketPlacement,
  type UseBasketPlacementResult,
  type PlaceBasketLegFn,
  type CancelBasketLegsFn,
} from './hooks/useBasketPlacement'

export {
  decomposeBasket,
  splitAmountExact,
  totalSellAtoms,
  type BasketComposition,
  type BasketSellInput,
  type BasketBuyInput,
  type DecomposedLeg,
} from './pure/decomposition'
export { readBasketTag } from './pure/readBasketTag'

export { BasketWidget, type BasketWidgetProps } from './pure/BasketWidget/BasketWidget.pure'
export { BasketConfirm, type BasketConfirmProps } from './pure/BasketConfirm/BasketConfirm.pure'
export { BasketStatus, type BasketStatusProps } from './pure/BasketStatus/BasketStatus.pure'
export { BasketBadge, type BasketBadgeProps } from './pure/BasketBadge/BasketBadge.pure'
