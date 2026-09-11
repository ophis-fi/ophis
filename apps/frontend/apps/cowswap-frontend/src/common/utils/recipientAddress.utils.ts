import { isAddress, isNonEvmBridgeDestination, NON_EVM_DESTINATION_RULES } from '@cowprotocol/common-utils'
import { AdditionalTargetChainId, isBtcAddress, isSolanaAddress } from '@cowprotocol/cow-sdk'

import { utils } from 'ethers'

export function isNonEvmRecipientChain(chainId: number | undefined): boolean {
  return (
    chainId === AdditionalTargetChainId.BITCOIN ||
    chainId === AdditionalTargetChainId.SOLANA ||
    isNonEvmBridgeDestination(chainId)
  )
}

/** Validate the destination wallet address, never the destination token identifier. */
export function isRecipientAddress(value: string | null | undefined, chainId: number | undefined): boolean {
  if (!value) return false
  if (chainId === AdditionalTargetChainId.BITCOIN) return isBtcAddress(value)
  // SDK validation is regex-only; a Solana public key must decode to 32 bytes.
  if (chainId === AdditionalTargetChainId.SOLANA) {
    try {
      return isSolanaAddress(value) && utils.base58.decode(value).length === 32
    } catch {
      return false
    }
  }
  // Non-EVM bridge-only destinations (Sui, Tron, Hyperliquid): one rule per chain.
  const rule = chainId !== undefined ? NON_EVM_DESTINATION_RULES[chainId] : undefined
  if (rule) return rule.isRecipientAddress(value)
  return !!isAddress(value)
}
