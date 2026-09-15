import { HYPERCORE_CHAIN_ID, SUI_CHAIN_ID, TRON_CHAIN_ID, TRX_NATIVE_CURRENCY_ADDRESS } from '@cowprotocol/common-const'
import { isAddress } from '@ethersproject/address'
import { Base58 } from '@ethersproject/basex'
import { arrayify } from '@ethersproject/bytes'
import { sha256 } from '@ethersproject/sha2'

/** Sui account address: 0x + 32 bytes. */
export const isSuiAddress = (value: string): boolean => /^0x[0-9a-fA-F]{64}$/.test(value)

/** Sui coin type, e.g. 0x2::sui::SUI or 0xdba3…::usdc::USDC. */
export const isSuiCoinType = (value: string): boolean =>
  /^0x[0-9a-fA-F]{1,64}::[A-Za-z_][A-Za-z0-9_]*::[A-Za-z_][A-Za-z0-9_]*$/.test(value)

/** Tron base58check address: 0x41 prefix + 20 bytes + 4-byte double-sha256 checksum, 34 chars starting with T. */
export function isTronAddress(value: string): boolean {
  if (!/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(value)) return false
  try {
    const bytes = Base58.decode(value)
    if (bytes.length !== 25 || bytes[0] !== 0x41) return false
    const check = arrayify(sha256(sha256(bytes.slice(0, 21))))
    return check[0] === bytes[21] && check[1] === bytes[22] && check[2] === bytes[23] && check[3] === bytes[24]
  } catch {
    return false
  }
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
