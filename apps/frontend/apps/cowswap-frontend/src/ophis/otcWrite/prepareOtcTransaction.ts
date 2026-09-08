import { isLocal as runtimeIsLocal } from '@cowprotocol/common-utils'
import { areAddressesEqual } from '@cowprotocol/cow-sdk'

import { OPHIS_ETHEREUM_OTC_MANIFEST, readOtcOrder, verifyOtcContract } from 'ophis/otc'
import { type Address, type Hex } from 'viem'

import { buildOtcTransaction, OTC_FILL_DEADLINE_WINDOW_SECONDS } from './buildOtcTransaction'
import { assertOtcWritePolicy } from './otcCanaryPolicy'
import { assertOtcReceipt } from './otcReceiptTracking.utils'
import { OtcReceiptTrackingError } from './otcReceiptTrackingError'
import { assertOtcRuntimeControl } from './otcRuntimeControl'
import { assertOtcTransactionHash, otcRequestHash } from './otcTransactionProof'
import { isOtcMainnetMode } from './otcWriteMode.utils'
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
import type { OtcSubmissionProof } from 'entities/otc'
import type { OtcManifest, OtcOrder } from 'ophis/otc'

function sameOrder(expected: OtcOrder, current: OtcOrder): boolean {
  return (
    expected.orderId === current.orderId &&
    areAddressesEqual(expected.maker, current.maker) &&
    expected.active === current.active &&
    areAddressesEqual(expected.tokenA, current.tokenA) &&
    expected.amountA === current.amountA &&
    areAddressesEqual(expected.tokenB, current.tokenB) &&
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
    ((runtimeIsLocal && runtimeWriteMode === 'fork') || isOtcMainnetMode(runtimeWriteMode))
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

function assertMainnetProof(
  mainnet: boolean,
  proof: OtcSubmissionProof | undefined,
  prepared: PreparedOtcTransaction,
): void {
  if (!mainnet) return
  if (
    !proof ||
    proof.requestHash !== otcRequestHash(prepared.request) ||
    !Number.isSafeInteger(proof.nonce) ||
    proof.nonce < 0
  )
    throw new Error('Ophis OTC transaction proof unavailable')
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
  onSignatureRequested: (proof: OtcSubmissionProof) => void = () => {
    throw new Error('Ophis OTC signature persistence unavailable')
  },
): Promise<OtcTransactionReceipt> {
  assertRuntimeAuthorization(authorization)
  if (isOtcMainnetMode(authorization.writeMode)) {
    assertOtcWritePolicy(intent, BigInt(Math.floor(Date.now() / 1_000)), authorization.writeMode)
    await assertOtcRuntimeControl()
  }
  const prepared = await prepareOtcTransaction(client, intent, manifest)
  const isStillAuthorized = (): boolean => {
    assertRuntimeAuthorization(authorization)
    if (isOtcMainnetMode(authorization.writeMode)) {
      assertOtcWritePolicy(prepared.intent, prepared.preparedAtTimestamp, authorization.writeMode)
      assertOtcWritePolicy(prepared.intent, BigInt(Math.floor(Date.now() / 1_000)), authorization.writeMode)
    }
    return isCurrentContext()
  }
  if (isOtcMainnetMode(authorization.writeMode)) await assertOtcRuntimeControl()
  if (!isStillAuthorized()) throw new Error('Ophis OTC action context changed')
  let submissionProof: OtcSubmissionProof | undefined
  const hash = await wallet.sendTransaction(
    prepared.request,
    prepared.intent,
    prepared.preparedAtTimestamp,
    isStillAuthorized,
    (proof) => {
      assertMainnetProof(isOtcMainnetMode(authorization.writeMode), proof, prepared)
      submissionProof = proof
      if (proof) onSignatureRequested(proof)
    },
  )
  assertOtcTransactionHash(hash)
  let receipt: OtcTransactionReceipt
  try {
    onBroadcast(hash)
    assertMainnetProof(isOtcMainnetMode(authorization.writeMode), submissionProof, prepared)
    receipt = await wallet.waitForTransactionReceipt(hash, submissionProof)
    assertOtcReceipt(hash, receipt)
  } catch (caught) {
    throw new OtcReceiptTrackingError(hash, caught)
  }
  if (receipt.status !== 'success') throw new Error('Ophis OTC transaction reverted')
  return receipt
}
