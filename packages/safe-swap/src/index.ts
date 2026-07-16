export { buildOphisSafePresign } from './build.js';
export type { OphisSafePresignParams, OphisSafePresignResult } from './build.js';
export { assembleVaultOrder, buildPresignTxBatch, computeOrderUid, assertUidMatches, ORDER_TTL_SECONDS } from './order.js';
export type { TxCall, VaultOrder } from './order.js';
export {
  MAX_SLIPPAGE_BPS,
  DEFAULT_SLIPPAGE_BPS,
  applySlippage,
  assertSlippageBps,
  assertSignedFeeZero,
  assertRequestBound,
  assertBuyFloor,
  assertErc20,
} from './guards.js';
