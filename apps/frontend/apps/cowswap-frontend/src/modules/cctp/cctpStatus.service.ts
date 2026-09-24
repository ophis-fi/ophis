import { areAddressesEqual } from '@cowprotocol/cow-sdk'

import {
  size,
  TransactionReceiptNotFoundError,
  type Transaction,
  type Address,
  type Hex,
  type TransactionReceipt,
} from 'viem'
import { z } from 'zod'

import { cctpNetwork } from './cctp.const'
import { cctpBurnData, cctpClient, circleGet, type CctpTransfer } from './cctp.service'
import { cctpService } from './cctpAssets.const'
import { messageInteger, validateCctpMessage, verifyBurnReceipt, verifyMintReceipt } from './cctpMessage.service'
export { validateCctpMessage, verifyBurnReceipt, verifyMintReceipt } from './cctpMessage.service'

const hex = z
  .string()
  .regex(/^0x(?:[a-fA-F0-9]{2})+$/)
  .transform((value) => value as Hex)
const hash = z
  .string()
  .regex(/^0x[a-fA-F0-9]{64}$/)
  .transform((value) => value as Hex)
const messagesSchema = z.object({
  sourceTxHash: hash.optional(),
  messages: z.array(
    z.object({
      message: z.string(),
      attestation: z.string().nullable().optional(),
      forwardTxHash: hash.nullable().optional(),
    }),
  ),
})

export interface CctpStatus {
  text: string
  sourceMessage?: Hex
  sourceConfirmed: boolean
  completed: boolean
  failed: boolean
  mintHash?: Hex
  claimPending?: boolean
  message?: Hex
  attestation?: Hex
}

export async function cctpReceipt(chainId: number, transactionHash: Hex): Promise<TransactionReceipt | null> {
  try {
    return await cctpClient(chainId).getTransactionReceipt({ hash: transactionHash })
  } catch (error) {
    if (error instanceof TransactionReceiptNotFoundError) return null
    throw error
  }
}

const waiting: CctpStatus = {
  text: 'Waiting for the source transaction',
  sourceConfirmed: false,
  completed: false,
  failed: false,
}

export function isCctpCancellation(transaction: Transaction, owner: Address, nonce: number | undefined): boolean {
  return (
    nonce !== undefined &&
    transaction.nonce === nonce &&
    areAddressesEqual(transaction.from, owner) &&
    areAddressesEqual(transaction.to, owner) &&
    transaction.input === '0x' &&
    transaction.value === 0n
  )
}

export async function isCctpFinalized(chainId: number, receipt: TransactionReceipt): Promise<boolean> {
  const finalized = await cctpClient(chainId).getBlock({ blockTag: 'finalized' })
  if (finalized.number === null || finalized.number < receipt.blockNumber) return false
  const canonical = await cctpClient(chainId).getBlock({ blockNumber: receipt.blockNumber })
  return canonical.hash === receipt.blockHash
}

async function finalizedFailure(
  transfer: CctpTransfer,
  receipt: TransactionReceipt,
  reason: string,
): Promise<CctpStatus> {
  if (!(await isCctpFinalized(transfer.source, receipt)))
    return { ...waiting, text: 'Waiting for the source transaction outcome to become final' }
  return { ...waiting, failed: true, text: `The source transaction was ${reason}. No tokens were bridged.` }
}

function assertBurnTransaction(transaction: Transaction, transfer: CctpTransfer): void {
  if (
    !areAddressesEqual(transaction.from, transfer.owner) ||
    !areAddressesEqual(transaction.to, cctpService(transfer.asset)) ||
    transaction.input.toLowerCase() !== cctpBurnData(transfer).toLowerCase() ||
    transaction.value !== (transfer.expanded ? BigInt(transfer.expanded.feeTotalAmount) : 0n) ||
    transaction.nonce !== transfer.sourceNonce
  )
    throw new Error('Transaction does not match the saved bridge')
}

async function sourceStatus(transfer: CctpTransfer): Promise<CctpStatus | Hex> {
  if (!transfer.burnHash)
    return { ...waiting, text: 'Check your wallet activity and paste the burn transaction hash to resume.' }
  const receipt = await cctpReceipt(transfer.source, transfer.burnHash)
  if (!receipt) return waiting
  // Recovery must never accept an unrelated reverted transaction as proof that
  // this burn failed: doing so could unlock a second burn after the first succeeded.
  const transaction = await cctpClient(transfer.source).getTransaction({ hash: transfer.burnHash })
  // A confirmed self-send at the saved nonce can be a wallet cancellation.
  // Wait for finality before releasing the journal; a reorg must not restore
  // the original burn after the UI permits a new transfer.
  if (isCctpCancellation(transaction, transfer.owner, transfer.sourceNonce))
    return finalizedFailure(transfer, receipt, 'cancelled')
  assertBurnTransaction(transaction, transfer)
  if (receipt.status === 'reverted') return finalizedFailure(transfer, receipt, 'reverted')
  const sourceMessage = verifyBurnReceipt(receipt, transfer)
  if (!(await isCctpFinalized(transfer.source, receipt)))
    return { ...waiting, text: 'Source included. Waiting for source finality.' }
  return sourceMessage
}

function assertAttestationSource(sourceTxHash: Hex | undefined, transfer: CctpTransfer): void {
  if (
    (transfer.expanded && !sourceTxHash) ||
    (sourceTxHash && sourceTxHash.toLowerCase() !== String(transfer.burnHash).toLowerCase())
  )
    throw new Error('Circle returned a different source transaction or omitted its hash')
}

function readAttestation(
  data: unknown,
  transfer: CctpTransfer,
  sourceMessage?: Hex,
): { message: Hex; attestation: Hex; forwardTxHash?: Hex | null } | null {
  const response = messagesSchema.parse(data)
  assertAttestationSource(response.sourceTxHash, transfer)
  if (response.messages.length !== 1) return null
  const entry = response.messages[0]
  if (!entry || entry.message === '0x' || !entry.attestation || entry.attestation === 'PENDING') return null
  const message = hex.parse(entry.message)
  const attestation = hex.parse(entry.attestation)
  validateCctpMessage(message, transfer, sourceMessage)
  if (messageInteger(message, 144, 4) < 2000n || size(attestation) % 65 !== 0)
    throw new Error('Incomplete CCTP attestation')
  return { message, attestation, forwardTxHash: entry.forwardTxHash }
}

async function destinationStatus(
  transfer: CctpTransfer,
  ready: CctpStatus & { message: Hex },
  forwardTxHash?: Hex | null,
): Promise<CctpStatus> {
  const hashes = [...new Set([transfer.mintHash, forwardTxHash].filter((value): value is Hex => !!value))]
  let result: CctpStatus = ready
  let pendingHash: Hex | undefined
  let claimPending = transfer.claimNonce !== undefined && !transfer.mintHash
  for (const mintHash of hashes) {
    const receipt = await cctpReceipt(transfer.destination, mintHash)
    if (!receipt) {
      pendingHash ??= mintHash
      if (mintHash === transfer.mintHash) claimPending = true
      continue
    }
    if (receipt.status === 'reverted') {
      result = { ...ready, text: 'Destination transaction reverted. You can retry claiming your tokens.' }
      continue
    }
    verifyMintReceipt(receipt, ready.message, transfer, ready.sourceMessage)
    if (!(await isCctpFinalized(transfer.destination, receipt)))
      return { ...ready, mintHash, claimPending: true, text: 'Tokens delivered. Waiting for destination finality.' }
    return { ...ready, mintHash, completed: true, text: 'Tokens received. Bridge complete.' }
  }
  if (pendingHash)
    return { ...ready, mintHash: pendingHash, claimPending, text: 'Waiting for destination confirmation' }
  if (claimPending)
    return {
      ...ready,
      claimPending: true,
      text: 'Check wallet activity and paste the destination claim hash to resume.',
    }
  return result
}

export async function getCctpStatus(
  transfer: CctpTransfer,
  sourceVerified: boolean | Hex = false,
): Promise<CctpStatus> {
  const proof = typeof sourceVerified === 'string' ? sourceVerified : undefined
  const source = !sourceVerified || (transfer.expanded && !proof) ? await sourceStatus(transfer) : proof
  if (source && typeof source !== 'string') return source
  const pending = {
    ...waiting,
    sourceConfirmed: true,
    sourceMessage: source,
    text: 'Source confirmed. Waiting for Circle attestation and delivery.',
  }
  const data = await circleGet(
    `/v2/messages/${cctpNetwork(transfer.source).domain}?transactionHash=${transfer.burnHash}`,
  )
  if (!data) return pending
  const entry = readAttestation(data, transfer, source)
  if (!entry) return pending
  const ready = {
    ...pending,
    message: entry.message,
    attestation: entry.attestation,
    text: 'Attestation ready. Circle is forwarding your tokens.',
  }
  return destinationStatus(transfer, ready, entry.forwardTxHash)
}
