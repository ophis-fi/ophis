import { areAddressesEqual } from '@cowprotocol/cow-sdk'

import {
  decodeEventLog,
  erc20Abi,
  isHex,
  size,
  slice,
  TransactionReceiptNotFoundError,
  zeroHash,
  type Hex,
  type TransactionReceipt,
} from 'viem'
import { z } from 'zod'

import { CCTP_ABI, FORWARD_HOOK, MESSAGE_TRANSMITTER, TOKEN_MESSENGER, cctpNetwork } from './cctp.const'
import { cctpAddressWord, cctpBurnData, cctpClient, circleGet, type CctpTransfer } from './cctp.service'

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
  sourceConfirmed: boolean
  completed: boolean
  failed: boolean
  mintHash?: Hex
  message?: Hex
  attestation?: Hex
}

function messageInteger(message: Hex, start: number, length: number): bigint {
  return BigInt(slice(message, start, start + length))
}

function assertMessageAddress(message: Hex, offset: number, address: string): void {
  if (slice(message, offset, offset + 32).toLowerCase() !== cctpAddressWord(address).toLowerCase())
    throw new Error('CCTP message address mismatch')
}

export function validateCctpMessage(message: Hex, transfer: CctpTransfer): void {
  if (!isHex(message) || size(message) !== 408) throw new Error('Invalid CCTP message length')
  const terms = [
    [0, 4, 1n],
    [4, 4, BigInt(cctpNetwork(transfer.source).domain)],
    [8, 4, BigInt(cctpNetwork(transfer.destination).domain)],
    [140, 4, 2000n],
    [148, 4, 1n],
    [216, 32, BigInt(transfer.amount)],
    [280, 32, BigInt(transfer.maxFee)],
  ] as const
  if (terms.some(([offset, length, expected]) => messageInteger(message, offset, length) !== expected))
    throw new Error('CCTP message terms mismatch')
  assertMessageAddress(message, 44, TOKEN_MESSENGER)
  assertMessageAddress(message, 76, TOKEN_MESSENGER)
  assertMessageAddress(message, 152, cctpNetwork(transfer.source).usdc)
  assertMessageAddress(message, 184, transfer.owner)
  assertMessageAddress(message, 248, transfer.owner)
  if (
    slice(message, 108, 140) !== zeroHash ||
    slice(message, 376) !== FORWARD_HOOK ||
    messageInteger(message, 312, 32) > BigInt(transfer.maxFee)
  )
    throw new Error('CCTP message caller, hook or fee mismatch')
}

export function verifyBurnReceipt(receipt: TransactionReceipt, transfer: CctpTransfer): void {
  if (
    receipt.status !== 'success' ||
    !areAddressesEqual(receipt.from, transfer.owner) ||
    !areAddressesEqual(receipt.to, TOKEN_MESSENGER)
  )
    throw new Error('Receipt is not the expected successful CCTP burn')
  const sent = receipt.logs
    .filter((log) => areAddressesEqual(log.address, MESSAGE_TRANSMITTER))
    .flatMap((log) => {
      try {
        const event = decodeEventLog({ abi: CCTP_ABI, eventName: 'MessageSent', ...log })
        return [event.args.message]
      } catch {
        return []
      }
    })
  if (sent.length !== 1 || !sent[0]) throw new Error('Expected one CCTP burn message')
  validateCctpMessage(sent[0], transfer)
}

export function verifyMintReceipt(receipt: TransactionReceipt, message: Hex, transfer: CctpTransfer): void {
  validateCctpMessage(message, transfer)
  if (receipt.status !== 'success') throw new Error('Destination transaction did not succeed')
  const messageReceived = receipt.logs.some((log) => {
    if (!areAddressesEqual(log.address, MESSAGE_TRANSMITTER)) return false
    try {
      const { args } = decodeEventLog({ abi: CCTP_ABI, eventName: 'MessageReceived', ...log })
      return (
        args.sourceDomain === cctpNetwork(transfer.source).domain &&
        args.nonce.toLowerCase() === slice(message, 12, 44).toLowerCase() &&
        args.sender.toLowerCase() === cctpAddressWord(TOKEN_MESSENGER).toLowerCase() &&
        args.finalityThresholdExecuted >= 2000 &&
        args.messageBody.toLowerCase() === slice(message, 148).toLowerCase()
      )
    } catch {
      return false
    }
  })
  const received = BigInt(transfer.amount) - messageInteger(message, 312, 32)
  const mintReceived = receipt.logs.some((log) => {
    if (!areAddressesEqual(log.address, cctpNetwork(transfer.destination).usdc)) return false
    try {
      const { args } = decodeEventLog({ abi: erc20Abi, eventName: 'Transfer', ...log })
      return areAddressesEqual(args.to, transfer.owner) && args.value === received
    } catch {
      return false
    }
  })
  if (!messageReceived || !mintReceived) throw new Error('Destination receipt does not confirm this USDC transfer')
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

async function sourceStatus(transfer: CctpTransfer): Promise<CctpStatus | null> {
  if (!transfer.burnHash)
    return { ...waiting, text: 'Check your wallet activity and paste the burn transaction hash to resume.' }
  const receipt = await cctpReceipt(transfer.source, transfer.burnHash)
  if (!receipt) return waiting
  // Recovery must never accept an unrelated reverted transaction as proof that
  // this burn failed: doing so could unlock a second burn after the first succeeded.
  const transaction = await cctpClient(transfer.source).getTransaction({ hash: transfer.burnHash })
  if (
    !areAddressesEqual(transaction.from, transfer.owner) ||
    !areAddressesEqual(transaction.to, TOKEN_MESSENGER) ||
    transaction.input.toLowerCase() !== cctpBurnData(transfer).toLowerCase() ||
    transaction.value !== 0n ||
    transaction.nonce !== transfer.sourceNonce
  )
    throw new Error('Transaction does not match the saved bridge')
  if (receipt.status === 'reverted')
    return { ...waiting, failed: true, text: 'The source transaction reverted. No USDC was bridged.' }
  verifyBurnReceipt(receipt, transfer)
  return null
}

function readAttestation(
  data: unknown,
  transfer: CctpTransfer,
): { message: Hex; attestation: Hex; forwardTxHash?: Hex | null } | null {
  const response = messagesSchema.parse(data)
  if (response.sourceTxHash && response.sourceTxHash.toLowerCase() !== String(transfer.burnHash).toLowerCase())
    throw new Error('Circle returned a different source transaction')
  if (response.messages.length !== 1) return null
  const entry = response.messages[0]
  if (!entry || entry.message === '0x' || !entry.attestation || entry.attestation === 'PENDING') return null
  const message = hex.parse(entry.message)
  const attestation = hex.parse(entry.attestation)
  validateCctpMessage(message, transfer)
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
  for (const mintHash of hashes) {
    const receipt = await cctpReceipt(transfer.destination, mintHash)
    if (!receipt) {
      result = { ...ready, mintHash, text: 'Waiting for destination confirmation' }
      continue
    }
    if (receipt.status === 'reverted') {
      result = { ...ready, text: 'Destination transaction reverted. You can retry claiming your USDC.' }
      continue
    }
    verifyMintReceipt(receipt, ready.message, transfer)
    return { ...ready, mintHash, completed: true, text: 'USDC received. Bridge complete.' }
  }
  return result
}

export async function getCctpStatus(transfer: CctpTransfer, sourceVerified = false): Promise<CctpStatus> {
  if (!sourceVerified) {
    const source = await sourceStatus(transfer)
    if (source) return source
  }
  const pending = {
    ...waiting,
    sourceConfirmed: true,
    text: 'Source confirmed. Waiting for Circle attestation and delivery.',
  }
  const data = await circleGet(
    `/v2/messages/${cctpNetwork(transfer.source).domain}?transactionHash=${transfer.burnHash}`,
  )
  if (!data) return pending
  const entry = readAttestation(data, transfer)
  if (!entry) return pending
  const ready = {
    ...pending,
    message: entry.message,
    attestation: entry.attestation,
    text: 'Attestation ready. Circle is forwarding your USDC.',
  }
  return destinationStatus(transfer, ready, entry.forwardTxHash)
}
