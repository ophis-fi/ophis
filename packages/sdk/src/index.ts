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
  OPHIS_STABLE_VOLUME_FEE_BPS,
  ophisVolumeBpsForPair,
  OPHIS_FEE_CHAIN_IDS,
  type OphisPartnerFee,
} from './partner-fee.js';

export {
  normalizeOphisReferralCode,
  buildOphisReferrerMetadata,
  type OphisReferrerTag,
} from './referral.js';

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
