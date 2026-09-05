import type { Address, Hex } from 'viem'

export interface OtcContractPin {
  address: Address
  runtimeCodeHash: Hex
}

export interface OtcManifest {
  chainId: 1
  chainLabel: 'Ethereum'
  contract: OtcContractPin
  wethAddress: Address
  deploymentBlock: bigint
  orderBatchSize: number
  maxEnumeratedOrders: number
  maxReturnBytes: number
  callGasLimit: bigint
  readTimeoutMs: number
  subgraphUrl: string
  subgraphTimeoutMs: number
  maxIndexLagBlocks: bigint
  tokenPolicyProfile: 'otc-escrow'
  /** Reviewed contract selectors enabled for the current milestone. */
  enabledTransactionSelectors: readonly Hex[]
}

export interface OtcBlock {
  number: bigint
  hash: Hex | null
  /** Authoritative EVM block timestamp in Unix seconds. */
  timestamp: bigint
}

export interface OtcReadCall {
  to: Address
  data: Hex
  gas: bigint
  blockNumber: bigint
}

/** Narrow read-only adapter. It deliberately has no transaction methods. */
export interface OtcReaderClient {
  getChainId(): Promise<number>
  getLatestBlock(): Promise<OtcBlock>
  getBlockByNumber(blockNumber: bigint): Promise<OtcBlock>
  getCode(address: Address, blockNumber: bigint): Promise<Hex | undefined>
  call(request: OtcReadCall): Promise<{ data?: Hex }>
}

/**
 * On-chain order terms. Field order mirrors the deployed struct layout
 * (maker, active, tokenA, amountA, tokenB, amountB): `active` is the SECOND
 * field on-chain even though upstream docs list it last.
 */
export interface OtcOrder {
  orderId: bigint
  maker: Address
  active: boolean
  /** Token the maker escrowed; a taker receives this leg. */
  tokenA: Address
  amountA: bigint
  /** Token the maker asks for; a taker pays this leg. */
  tokenB: Address
  amountB: bigint
}

export interface OtcSnapshot {
  chainId: 1
  blockNumber: bigint
  blockHash: Hex
  nextOrderId: bigint
  /** Newest-first, bounded by the manifest's maxEnumeratedOrders. */
  orders: OtcOrder[]
  /** True when older order ids exist beyond the enumerated window. */
  truncated: boolean
}

/** Discovery-only row from the third-party subgraph. Never settlement authority. */
export interface OtcIndexedOrder {
  orderId: bigint
  maker: Address
  active: boolean
  tokenA: Address
  amountA: bigint
  tokenB: Address
  amountB: bigint
  createdAt: number
  createdTx: Hex
  taker: Address | null
  filledAt: number | null
  filledTx: Hex | null
  cancelledAt: number | null
  cancelledTx: Hex | null
}

export type OtcOrderField = 'maker' | 'active' | 'tokenA' | 'amountA' | 'tokenB' | 'amountB'

export interface OtcOrderMismatch {
  orderId: bigint
  field: OtcOrderField
  indexed: string
  onchain: string
}

export interface OtcReconciliationReport {
  /** Order ids whose indexed terms exactly match on-chain state. */
  verifiedIds: bigint[]
  mismatches: OtcOrderMismatch[]
  /** Indexed ids inside the enumerated range that the chain says do not exist. */
  missingOnchain: bigint[]
  /** On-chain ids absent from the index. */
  notIndexed: bigint[]
  /** Indexed ids outside the snapshot's enumerated window; never verified. */
  unknownIds: bigint[]
  /**
   * Ids whose immutable terms match but whose active flag disagrees — normal
   * index lag around fills/cancels, reported separately so lag is never
   * presented as data corruption (and never verified either).
   */
  activeLagIds: bigint[]
}

export interface OtcEnrichment {
  byOrderId: ReadonlyMap<string, OtcIndexedOrder>
  indexedBlock: bigint
}

export type OtcDataStatus = 'loading' | 'ready' | 'degraded' | 'unavailable'

export type OtcDegradedReason = 'index-unavailable' | 'index-stale' | 'index-corrupt' | 'node-stale'

export interface OtcDataState {
  status: OtcDataStatus
  degradedReason: OtcDegradedReason | null
  snapshot: OtcSnapshot | null
  enrichment: OtcEnrichment | null
  reconciliation: OtcReconciliationReport | null
  indexLagBlocks: bigint | null
}
