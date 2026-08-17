import type { Address, Hex } from 'viem'

export interface OphisDiscoveryContractPin {
  address: Address
  runtimeCodeHash: Hex
}

export interface OphisDiscoveryManifest {
  chainId: 1
  chainLabel: 'Ethereum'
  registry: OphisDiscoveryContractPin
  lens: OphisDiscoveryContractPin
  ranking: OphisDiscoveryContractPin
  pageSize: number
  callGasLimit: bigint
  maxReturnBytes: number
}

export interface OphisDiscoveryBlock {
  number: bigint
  hash: Hex | null
}

export interface OphisDiscoveryCall {
  to: Address
  data: Hex
  gas: bigint
  blockNumber: bigint
}

/** Narrow read-only adapter. It deliberately has no transaction methods. */
export interface OphisDiscoveryReaderClient {
  getLatestBlock(): Promise<OphisDiscoveryBlock>
  getBlockByNumber(blockNumber: bigint): Promise<OphisDiscoveryBlock>
  getCode(address: Address, blockNumber: bigint): Promise<Hex | undefined>
  call(request: OphisDiscoveryCall): Promise<{ data?: Hex }>
}

export interface OphisDiscoveredToken {
  id: string
  address: Address
  chainId: 1
  decimals: number
  name: string
  symbol: string
  rank: number
}

export interface OphisDiscoverySnapshot {
  chainId: 1
  chainLabel: 'Ethereum'
  blockNumber: bigint
  blockHash: Hex
  tokens: OphisDiscoveredToken[]
}

export type OphisDiscoveryState =
  | { status: 'idle'; snapshot: null }
  | { status: 'loading'; snapshot: null }
  | { status: 'ready'; snapshot: OphisDiscoverySnapshot }
  | { status: 'unavailable'; snapshot: null }
