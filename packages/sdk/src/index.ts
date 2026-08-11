export {
  ophisDefaults,
  OPHIS_CHAIN_IDS,
  type OphisDefaults,
} from './config.js';

export {
  ophisDefaultPartnerFee,
  buildOphisAppDataPartnerFee,
  OPHIS_PARTNER_FEE_RECIPIENT,
  OPHIS_VOLUME_FEE_BPS,
  OPHIS_PRICE_IMPROVEMENT_BPS,
  OPHIS_PRICE_IMPROVEMENT_MAX_VOLUME_BPS,
  OPHIS_STABLE_PRICE_IMPROVEMENT_BPS,
  OPHIS_STABLE_PRICE_IMPROVEMENT_MAX_VOLUME_BPS,
  OPHIS_MAX_PARTNER_REQUEST_BPS,
  OPHIS_AGGREGATE_PARTNER_FEE_CAP_BPS,
  OPHIS_STABLE_VOLUME_FEE_BPS,
  OPHIS_SOVEREIGN_VOLUME_FEE_BPS,
  ophisVolumeBpsForChainAndPair,
  ophisVolumeBpsForPair,
  OPHIS_FEE_CHAIN_IDS,
  type OphisPartnerFee,
  type OphisVolumePartnerFee,
  type OphisPriceImprovementPartnerFee,
  type OphisPartnerFeeConfig,
} from './partner-fee.js';

export { OPHIS_STABLECOINS, isOphisStablePair } from './stablecoins.js';

export {
  normalizeOphisReferralCode,
  buildOphisReferrerMetadata,
  type OphisReferrerTag,
} from './referral.js';

export {
  OPHIS_BASKET_ID_RE,
  MAX_BASKET_SELL_TOKENS,
  MAX_BASKET_BUY_TOKENS,
  MAX_BASKET_LEGS,
  assertOphisBasketId,
  newOphisBasketId,
  assertOphisBasketLegs,
  buildOphisBasketMetadata,
  type OphisBasketTag,
} from './basket-metadata.js';

export {
  getOphisOrderbookUrl,
  OPHIS_ORDERBOOK_URLS,
} from './orderbook.js';

export {
  getOphisSettlementAddress,
  getOphisOrderDomain,
  OPHIS_SETTLEMENT_ADDRESSES,
  getOphisVaultRelayer,
  OPHIS_VAULT_RELAYER_ADDRESSES,
  type OphisOrderDomain,
} from './domain.js';

export {
  ophisOrderReceiver,
  assertReceiverIsOwner,
  type ReceiverOptions,
  type AssertReceiverOptions,
} from './order.js';

export {
  assertValidChainId,
  isAddressLike,
  assertAddressLike,
  addressesEqual,
  isZeroAddress,
  isBytes32,
  assertBytes32,
} from './guards.js';

export {
  TIERS,
  POOL_SPLIT_BPS,
  assignTier,
  type Tier,
} from './tiers.js';

export {
  OPHIS_REBATE_INDEXER_URL,
  isOphisFeeChain,
  buildOphisOrderMetadata,
  enrollOphisTrader,
  buildOphisOrderCreation,
  type OphisSigningScheme,
  type OphisOrderMetadataOptions,
  type OphisAppDataInput,
  type EnrollOphisTraderOptions,
  type EnrollOphisTraderResult,
  type OphisOrderCreationOptions,
} from './flow.js';

export {
  OPHIS_ETHFLOW_ADDRESSES,
  isOphisEthFlowChain,
  getOphisEthFlowAddress,
  buildOphisEthFlowOrder,
  ethFlowOrderToTuple,
  ETHFLOW_CREATE_ORDER_ABI,
  ETHFLOW_CREATE_ORDER_ABI_HUMAN,
  type EthFlowOrderData,
  type EthFlowOrderTuple,
  type OphisEthFlowParams,
  type OphisEthFlowOrder,
} from './ethflow.js';

export {
  OPHIS_ERROR_CODES,
  OPHIS_UNROUTABLE_CODES,
  ophisErrorBand,
  getOphisTraceId,
  OphisApiError,
  OphisUnroutableError,
  OphisRateLimitError,
  parseOphisApiError,
  isUnroutable,
  isRetryable,
  withOphisRetry,
  type OphisErrorBand,
  type OphisHeadersLike,
  type OphisErrorResponse,
  type OphisApiErrorOptions,
  type OphisRetryOptions,
} from './errors.js';

export {
  MULTICALL3_ADDRESS,
  ERC20_PREFLIGHT_ABI,
  ophisPreflight,
  isPreflightReady,
  approvalNeeded,
  OphisPreflightError,
  type OphisMulticallCall,
  type OphisMulticallClient,
  type OphisPreflightRequest,
  type OphisPreflightResult,
} from './preflight.js';

export {
  APP_DATA_VERSION,
  ORDER_TYPED_DATA_TYPES,
  MAX_SLIPPAGE_BIPS,
  MAX_PARTNER_FEE_ENTRIES,
  deterministicStringify,
  buildOphisFullAppData,
  buildOrder,
  assertChain,
  checksum,
  assertAtoms,
  assertFeeAtoms,
  extractQuoteAmounts,
  assertLimitWithinSlippage,
  type Address,
  type OphisAppData,
  type BuildOrderParams,
  type BuiltOrder,
} from './order-build.js';
