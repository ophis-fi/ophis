import {
  HYPERCORE_CHAIN_ID,
  STARKNET_CHAIN_ID,
  ZCASH_CHAIN_ID,
  ZEC_NATIVE_CURRENCY_ADDRESS,
  SUI_CHAIN_ID,
  TRON_CHAIN_ID,
  TRX_NATIVE_CURRENCY_ADDRESS,
} from '@cowprotocol/common-const'
import { isAddress } from '@ethersproject/address'
import { Base58 } from '@ethersproject/basex'
import { arrayify } from '@ethersproject/bytes'
import { sha256 } from '@ethersproject/sha2'

import { bech32, bech32m } from 'bech32'

/** Sui account address: 0x + 32 bytes. */
export const isSuiAddress = (value: string): boolean => /^0x[0-9a-fA-F]{64}$/.test(value)

/** Sui coin type, e.g. 0x2::sui::SUI or 0xdba3…::usdc::USDC. */
export const isSuiCoinType = (value: string): boolean =>
  /^0x[0-9a-fA-F]{1,64}::[A-Za-z_][A-Za-z0-9_]*::[A-Za-z_][A-Za-z0-9_]*$/.test(value)

function isBase58Check(value: string, prefix: number[]): boolean {
  try {
    const bytes = Base58.decode(value)
    if (bytes.length !== prefix.length + 24 || !prefix.every((byte, index) => byte === bytes[index])) return false
    const dataLength = bytes.length - 4
    const checksum = arrayify(sha256(sha256(bytes.slice(0, dataLength))))
    return checksum.slice(0, 4).every((byte, index) => byte === bytes[dataLength + index])
  } catch {
    return false
  }
}

/** Tron mainnet Base58Check recipient. */
export function isTronAddress(value: string): boolean {
  return /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(value) && isBase58Check(value, [0x41])
}

/** Mainnet Bitcoin recipients: Base58Check, SegWit v0 and Taproot v1. */
export function isBitcoinAddress(value: string): boolean {
  try {
    if (/^[13][1-9A-HJ-NP-Za-km-z]{24,33}$/.test(value)) {
      return isBase58Check(value, value[0] === '1' ? [0] : [5])
    }
    const codec = /^bc1q/i.test(value) ? bech32 : bech32m
    const decoded = codec.decode(value)
    const version = decoded.words[0]
    const length = codec.fromWords(decoded.words.slice(1)).length
    return decoded.prefix === 'bc' && ((version === 0 && [20, 32].includes(length)) || (version === 1 && length === 32))
  } catch {
    return false
  }
}

/** Starknet contract addresses are nonzero and below the address upper bound, not EVM addresses. */
export function isStarknetAddress(value: string): boolean {
  return /^0x[0-9a-fA-F]{1,64}$/.test(value) && BigInt(value) > 0n && BigInt(value) < (1n << 251n) - 256n
}

/** NEAR supports Zcash mainnet transparent t1/t3 addresses only. */
export function isZcashAddress(value: string): boolean {
  return (
    /^t[13][1-9A-HJ-NP-Za-km-z]{33}$/.test(value) &&
    isBase58Check(value, value[1] === '1' ? [0x1c, 0xb8] : [0x1c, 0xbd])
  )
}

/** Hyperliquid (Hypercore) account: a 0x EVM address with a valid checksum (ethers isAddress alone also admits ICAP). */
export const isHypercoreAddress = (value: string): boolean => value.startsWith('0x') && isAddress(value)

/**
 * Hypercore asset id: the HIP-1 spot token id (0x + 16 bytes). NEAR also lists
 * an erc20 mirror under an EVM address; the picker hides it and the policy
 * rejects it, so one predicate serves both.
 */
export const isHypercoreTokenId = (value: string): boolean => /^0x[0-9a-fA-F]{32}$/.test(value)

/** The Tron zero address (our native sentinel) is a black hole, never a recipient. */
const isTronRecipient = (value: string): boolean => value !== TRX_NATIVE_CURRENCY_ADDRESS && isTronAddress(value)

export interface NonEvmDestinationRules {
  /** What the user types into the recipient field. */
  isRecipientAddress(value: string): boolean
  /** What NEAR reports as the token's address / id on that chain. */
  isTokenId(value: string): boolean
}

/**
 * Per-chain address rules for the non-EVM bridge-only destinations. A chain
 * absent here is EVM (Monad, X Layer) and uses the normal 0x validation.
 * Consulted by the recipient validators, the token policy and the address
 * shorteners, so a new chain is added in exactly one place.
 */
export const NON_EVM_DESTINATION_RULES: Readonly<Partial<Record<number, NonEvmDestinationRules>>> = {
  [STARKNET_CHAIN_ID]: { isRecipientAddress: isStarknetAddress, isTokenId: isStarknetAddress },
  [ZCASH_CHAIN_ID]: { isRecipientAddress: isZcashAddress, isTokenId: (value) => value === ZEC_NATIVE_CURRENCY_ADDRESS },
  [SUI_CHAIN_ID]: { isRecipientAddress: isSuiAddress, isTokenId: isSuiCoinType },
  [TRON_CHAIN_ID]: { isRecipientAddress: isTronRecipient, isTokenId: isTronAddress },
  [HYPERCORE_CHAIN_ID]: { isRecipientAddress: isHypercoreAddress, isTokenId: isHypercoreTokenId },
}

export function isNonEvmBridgeDestination(chainId: number | undefined): boolean {
  return chainId !== undefined && chainId in NON_EVM_DESTINATION_RULES
}

/**
 * True when the string is a valid recipient or token id on some non-EVM bridge
 * destination AND is not an EVM-format address (those keep the EVM code paths;
 * a Hypercore recipient is an EVM address). Chain-agnostic on purpose: used
 * where only the string is known (address shortening, persisted token ids).
 */
export function isNonEvmDestinationString(value: string): boolean {
  if (isAddress(value)) return false
  return Object.values(NON_EVM_DESTINATION_RULES).some(
    (rule) => rule !== undefined && (rule.isRecipientAddress(value) || rule.isTokenId(value)),
  )
}
