import { isLocal as runtimeIsLocal } from '@cowprotocol/common-utils'

import { OPHIS_ETHEREUM_OTC_MANIFEST, readOtcOrder, verifyOtcContract } from 'ophis/otc'
import { isAddressEqual, type Address, type Hex } from 'viem'

import { buildOtcTransaction, OTC_FILL_DEADLINE_WINDOW_SECONDS } from './buildOtcTransaction'
import { OtcReceiptTrackingError } from './otcReceiptTrackingError'
import { withOtcPreflightTimeout } from './otcWriteTimeouts'
import { readOtcAllowanceAtBlock } from './readOtcAllowance'

import type {
  OtcTransactionReceipt,
  OtcWalletSubmitter,
  OtcWriteClient,
  OtcWriteIntent,
  OtcWriteRuntimeAuthorization,
  PreparedOtcTransaction,
} from './otcWrite.types'
import type { OtcManifest, OtcOrder } from 'ophis/otc'

function sameOrder(expected: OtcOrder, current: OtcOrder): boolean {
  return (
    expected.orderId === current.orderId &&
    isAddressEqual(expected.maker, current.maker) &&
    expected.active === current.active &&
    isAddressEqual(expected.tokenA, current.tokenA) &&
    expected.amountA === current.amountA &&
    isAddressEqual(expected.tokenB, current.tokenB) &&
    expected.amountB === current.amountB
  )
}

function orderFromIntent(intent: OtcWriteIntent): OtcOrder | null {
  return intent.kind === 'approve-fill' || intent.kind === 'fill' || intent.kind === 'cancel' ? intent.order : null
}

type AllowanceRequirement = { token: Address; exact: bigint } | { token: Address; positive: true }

function preflightAllowance(intent: OtcWriteIntent): AllowanceRequirement | null {
  if (intent.kind === 'approve-create') return { token: intent.draft.tokenA, exact: 0n }
  if (intent.kind === 'approve-fill') return { token: intent.order.tokenB, exact: 0n }
  if (intent.kind === 'create') return { token: intent.draft.tokenA, exact: intent.draft.amountA }
  if (intent.kind === 'fill') return { token: intent.order.tokenB, exact: intent.order.amountB }
  if (intent.kind === 'revoke-create') return { token: intent.draft.tokenA, positive: true }
  if (intent.kind === 'revoke-fill') return { token: intent.order.tokenB, positive: true }
  return null
}

function withVerifiedDeadline(intent: OtcWriteIntent, blockTimestamp: bigint): OtcWriteIntent {
  return intent.kind === 'fill' ? { ...intent, deadline: blockTimestamp + OTC_FILL_DEADLINE_WINDOW_SECONDS } : intent
}

function assertBlockIdentity(blockNumber: bigint, blockHash: Hex, block: { number: bigint; hash: Hex | null }): void {
  if (block.number !== blockNumber || !block.hash || block.hash !== blockHash) {
    throw new Error('Ophis OTC block changed')
  }
}

function assertRuntimeAuthorization(authorization: OtcWriteRuntimeAuthorization): void {
  const runtimeWriteMode = process.env.REACT_APP_OTC_WRITE_MODE
  const enabled =
    authorization.readFlag === true &&
    authorization.writeFlag === true &&
    authorization.isLocal === runtimeIsLocal &&
    authorization.writeMode === runtimeWriteMode &&
    runtimeIsLocal &&
    runtimeWriteMode === 'fork'
  if (!enabled) throw new Error('Ophis OTC writes are disabled')
}

/**
 * Re-verifies the deployed source, re-reads order terms where applicable, and
 * simulates the exact calldata at that verified block. No wallet call occurs.
 */
async function runOtcTransactionPreflight(
  client: OtcWriteClient,
  intent: OtcWriteIntent,
  manifest: OtcManifest = OPHIS_ETHEREUM_OTC_MANIFEST,
): Promise<PreparedOtcTransaction> {
  const expectedOrder = orderFromIntent(intent)
  let blockNumber: bigint
  let blockHash: Hex

  if (expectedOrder) {
    const current = await readOtcOrder(client, expectedOrder.orderId, manifest)
    if (!current.order || !sameOrder(expectedOrder, current.order)) {
      throw new Error('Ophis OTC order changed before submission')
    }
    blockNumber = current.blockNumber
    blockHash = current.blockHash
  } else {
    const verified = await verifyOtcContract(client, manifest)
    blockNumber = verified.blockNumber
    blockHash = verified.blockHash
  }

  const verifiedBlock = await client.getBlockByNumber(blockNumber)
  assertBlockIdentity(blockNumber, blockHash, verifiedBlock)
  if (verifiedBlock.timestamp < 0n) throw new Error('Ophis OTC block timestamp rejected')
  const preparedIntent = withVerifiedDeadline(intent, verifiedBlock.timestamp)
  const request = buildOtcTransaction(preparedIntent, verifiedBlock.timestamp)
  const requiredAllowance = preflightAllowance(preparedIntent)
  if (requiredAllowance) {
    const allowance = await readOtcAllowanceAtBlock(
      client,
      requiredAllowance.token,
      preparedIntent.account,
      blockNumber,
      manifest,
    )
    const accepted = 'exact' in requiredAllowance ? allowance === requiredAllowance.exact : allowance > 0n
    if (!accepted) throw new Error('Ophis OTC exact allowance required')
  }
  await client.simulate(request, blockNumber)
  const confirmedBlock = await client.getBlockByNumber(blockNumber)
  assertBlockIdentity(blockNumber, blockHash, confirmedBlock)
  return {
    request,
    intent: preparedIntent,
    preparedAtTimestamp: verifiedBlock.timestamp,
    simulatedAtBlock: blockNumber,
  }
}

export function prepareOtcTransaction(
  client: OtcWriteClient,
  intent: OtcWriteIntent,
  manifest: OtcManifest = OPHIS_ETHEREUM_OTC_MANIFEST,
): Promise<PreparedOtcTransaction> {
  return withOtcPreflightTimeout(runOtcTransactionPreflight(client, intent, manifest))
}

/**
 * The only wallet-submission sink. Authorization is checked again immediately
 * before fresh preflight, exact simulation, submission, and receipt tracking.
 */
export async function submitOtcTransaction(
  client: OtcWriteClient,
  wallet: OtcWalletSubmitter,
  intent: OtcWriteIntent,
  authorization: OtcWriteRuntimeAuthorization,
  manifest: OtcManifest = OPHIS_ETHEREUM_OTC_MANIFEST,
  isCurrentContext: () => boolean = () => true,
  onBroadcast: (hash: Hex) => void = () => undefined,
): Promise<OtcTransactionReceipt> {
  assertRuntimeAuthorization(authorization)
  const prepared = await prepareOtcTransaction(client, intent, manifest)
  assertRuntimeAuthorization(authorization)
  if (!isCurrentContext()) throw new Error('Ophis OTC action context changed')
  const hash = await wallet.sendTransaction(
    prepared.request,
    prepared.intent,
    prepared.preparedAtTimestamp,
    isCurrentContext,
  )
  let receipt: OtcTransactionReceipt
  try {
    onBroadcast(hash)
    receipt = await wallet.waitForTransactionReceipt(hash)
    if (receipt.transactionHash.toLowerCase() !== hash.toLowerCase()) {
      throw new Error('Ophis OTC transaction was replaced')
    }
  } catch (caught) {
    throw new OtcReceiptTrackingError(hash, caught)
  }
  if (receipt.status !== 'success') throw new Error('Ophis OTC transaction reverted')
  return receipt
}
