import { getChainInfo } from '@cowprotocol/common-const'
import {
  isAddress,
  isNonEvmBridgeDestination,
  isNonEvmDestinationString,
  NON_EVM_DESTINATION_RULES,
} from '@cowprotocol/common-utils'
import { AdditionalTargetChainId, isBtcAddress, isSolanaAddress } from '@cowprotocol/cow-sdk'

import { t } from '@lingui/core/macro'
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

/** A recipient string worth rendering as a linked address (EVM, or a non-EVM destination format). */
export function isDisplayableRecipient(value: string | null | undefined): boolean {
  return !!value && (!!isAddress(value) || isNonEvmDestinationString(value))
}

/** Input placeholder: ENS and .wei names only resolve on EVM destinations. */
export function getRecipientPlaceholder(chainId: number): string {
  if (chainId === AdditionalTargetChainId.SOLANA) return t`Solana wallet address`
  if (chainId === AdditionalTargetChainId.BITCOIN) return t`Bitcoin wallet address`
  if (isNonEvmBridgeDestination(chainId)) {
    const label = getChainInfo(chainId as Parameters<typeof getChainInfo>[0])?.label ?? ''
    return t`${label} wallet address`
  }
  return t`Wallet address, ENS, or .wei name`
}
