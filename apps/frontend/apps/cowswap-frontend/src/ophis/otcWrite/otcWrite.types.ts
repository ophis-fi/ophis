import type { OtcOrder, OtcReaderClient } from 'ophis/otc'
import type { Address, Hex } from 'viem'

export interface OtcCreateDraft {
  tokenA: Address
  amountA: bigint
  tokenB: Address
  amountB: bigint
}

interface OtcWriteIntentBase {
  account: Address
}

export interface OtcApproveCreateIntent extends OtcWriteIntentBase {
  kind: 'approve-create'
  draft: OtcCreateDraft
}

export interface OtcCreateIntent extends OtcWriteIntentBase {
  kind: 'create'
  draft: OtcCreateDraft
}

export interface OtcApproveFillIntent extends OtcWriteIntentBase {
  kind: 'approve-fill'
  order: OtcOrder
}

export interface OtcRevokeCreateIntent extends OtcWriteIntentBase {
  kind: 'revoke-create'
  draft: Pick<OtcCreateDraft, 'tokenA' | 'tokenB'>
}

export interface OtcRevokeFillIntent extends OtcWriteIntentBase {
  kind: 'revoke-fill'
  order: OtcOrder
}

export interface OtcFillIntent extends OtcWriteIntentBase {
  kind: 'fill'
  order: OtcOrder
  deadline: bigint
}

export interface OtcCancelIntent extends OtcWriteIntentBase {
  kind: 'cancel'
  order: OtcOrder
}

export type OtcWriteIntent =
  | OtcApproveCreateIntent
  | OtcCreateIntent
  | OtcApproveFillIntent
  | OtcRevokeCreateIntent
  | OtcRevokeFillIntent
  | OtcFillIntent
  | OtcCancelIntent

export interface OtcTransactionRequest {
  kind: OtcWriteIntent['kind']
  chainId: 1
  account: Address
  to: Address
  data: Hex
  /** Milestone C is ERC-20-only; every request must carry zero ETH. */
  value: 0n
}

export interface OtcWriteClient extends OtcReaderClient {
  simulate(request: OtcTransactionRequest, blockNumber: bigint): Promise<void>
}

export interface OtcTransactionReceipt {
  transactionHash: Hex
  /** Present only after the adapter verifies an identical transaction was repriced. */
  replacedTransactionHash?: Hex
  status: 'success' | 'reverted'
  blockNumber: bigint
}

export type OtcConfirmedCallback = (transactionHash: Hex) => void

export interface OtcWalletSubmitter {
  sendTransaction(
    request: OtcTransactionRequest,
    intent: OtcWriteIntent,
    nowSeconds: bigint,
    isCurrentContext?: () => boolean,
  ): Promise<Hex>
  waitForTransactionReceipt(hash: Hex): Promise<OtcTransactionReceipt>
}

export interface OtcWriteRuntimeAuthorization {
  isLocal: boolean
  readFlag: unknown
  writeFlag: unknown
  writeMode: string | undefined
}

export interface PreparedOtcTransaction {
  request: OtcTransactionRequest
  intent: OtcWriteIntent
  preparedAtTimestamp: bigint
  simulatedAtBlock: bigint
}
