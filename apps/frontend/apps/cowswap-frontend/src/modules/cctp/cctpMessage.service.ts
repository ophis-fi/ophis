import { areAddressesEqual } from '@cowprotocol/cow-sdk'

import { decodeEventLog, erc20Abi, isHex, size, slice, zeroHash, type Hex, type TransactionReceipt } from 'viem'

import { CCTP_ABI, FORWARD_HOOK, MESSAGE_TRANSMITTER, TOKEN_MESSENGER, cctpNetwork } from './cctp.const'
import { cctpAddressWord, type CctpTransfer } from './cctp.service'
import { cctpService, cctpToken } from './cctpAssets.const'

function validateCctpxHeader(message: Hex, transfer: CctpTransfer): void {
  if (!isHex(message) || size(message) <= 148 || size(message) > 16384)
    throw new Error('Invalid non-USDC message length')
  const terms = [
    [0, 1n],
    [4, BigInt(cctpNetwork(transfer.source).domain)],
    [8, BigInt(cctpNetwork(transfer.destination).domain)],
    [140, 2000n],
  ] as const
  if (
    terms.some(([offset, expected]) => messageInteger(message, offset, 4) !== expected) ||
    slice(message, 108, 140) !== zeroHash
  )
    throw new Error('Non-USDC message route or finality mismatch')
  assertMessageAddress(message, 44, cctpService(transfer.asset))
  assertMessageAddress(message, 76, cctpService(transfer.asset))
}

export function messageInteger(message: Hex, start: number, length: number): bigint {
  return BigInt(slice(message, start, start + length))
}

function assertMessageAddress(message: Hex, offset: number, address: string): void {
  if (slice(message, offset, offset + 32).toLowerCase() !== cctpAddressWord(address).toLowerCase())
    throw new Error('CCTP message address mismatch')
}

export function validateCctpMessage(message: Hex, transfer: CctpTransfer, sourceMessage?: Hex): void {
  if (transfer.asset && transfer.asset !== 'USDC') {
    validateCctpxHeader(message, transfer)
    if (!sourceMessage || slice(message, 148).toLowerCase() !== slice(sourceMessage, 148).toLowerCase())
      throw new Error('Non-USDC attestation does not match the verified source message')
    return
  }
  validateUsdcMessage(message, transfer)
}

function validateUsdcMessage(message: Hex, transfer: CctpTransfer): void {
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

export function verifyBurnReceipt(receipt: TransactionReceipt, transfer: CctpTransfer): Hex {
  if (
    receipt.status !== 'success' ||
    !areAddressesEqual(receipt.from, transfer.owner) ||
    !areAddressesEqual(receipt.to, cctpService(transfer.asset))
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
  validateCctpMessage(sent[0], transfer, sent[0])
  return sent[0]
}

export function verifyMintReceipt(
  receipt: TransactionReceipt,
  message: Hex,
  transfer: CctpTransfer,
  sourceMessage?: Hex,
): void {
  validateCctpMessage(message, transfer, sourceMessage)
  if (receipt.status !== 'success') throw new Error('Destination transaction did not succeed')
  const messageReceived = receipt.logs.some((log) => {
    if (!areAddressesEqual(log.address, MESSAGE_TRANSMITTER)) return false
    try {
      const { args } = decodeEventLog({ abi: CCTP_ABI, eventName: 'MessageReceived', ...log })
      return (
        args.sourceDomain === cctpNetwork(transfer.source).domain &&
        args.nonce.toLowerCase() === slice(message, 12, 44).toLowerCase() &&
        args.sender.toLowerCase() === cctpAddressWord(cctpService(transfer.asset)).toLowerCase() &&
        args.finalityThresholdExecuted >= 2000 &&
        args.messageBody.toLowerCase() === slice(message, 148).toLowerCase()
      )
    } catch {
      return false
    }
  })
  const received = BigInt(transfer.amount) - (transfer.expanded ? 0n : messageInteger(message, 312, 32))
  const mintReceived = receipt.logs.some((log) => {
    if (!areAddressesEqual(log.address, cctpToken(transfer.destination, transfer.asset))) return false
    try {
      const { args } = decodeEventLog({ abi: erc20Abi, eventName: 'Transfer', ...log })
      return areAddressesEqual(args.to, transfer.owner) && args.value === received
    } catch {
      return false
    }
  })
  if (!messageReceived || !mintReceived) throw new Error('Destination receipt does not confirm this token transfer')
}
