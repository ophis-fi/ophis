import { DAI, NATIVE_CURRENCY_ADDRESS, USDC_MAINNET, WETH_MAINNET } from '@cowprotocol/common-const'
import { isAddress, isSupportedChainId } from '@cowprotocol/common-utils'
import { getAddressKey, SupportedChainId } from '@cowprotocol/cow-sdk'
import type { Currency } from '@cowprotocol/currency'

export type TokenPolicyReason = 'approved' | 'invalid-token' | 'chain-not-reviewed' | 'token-not-reviewed'

export interface TokenPolicyDecision {
  readonly allowed: boolean
  readonly reason: TokenPolicyReason
}

export interface TokenPolicyAsset {
  readonly chainId: number
  readonly address: string
}

export enum TokenPolicyProfile {
  ESTABLISHED_SETTLEMENT = 'established-settlement',
  RESTRICTED_EXECUTION = 'restricted-execution',
  OTC_ESCROW = 'otc-escrow',
}

const APPROVED_ETHEREUM_ASSETS = new Set(
  [NATIVE_CURRENCY_ADDRESS, WETH_MAINNET.address, USDC_MAINNET.address, DAI.address].map(getAddressKey),
)

/**
 * Escrow deposits cannot be paused or recovered by Ophis, so the OTC profile
 * allowlists exact ERC-20 addresses only. The native sentinel is excluded:
 * ETH reaches the escrow contract solely through its reviewed WETH
 * convenience functions, never as a policy-approved order leg.
 */
const OTC_ESCROW_ETHEREUM_ASSETS = new Set(
  [WETH_MAINNET.address, USDC_MAINNET.address, DAI.address].map(getAddressKey),
)

/**
 * Existing settlement routes retain their established token support and
 * backend validation. A separately approved execution integration must opt in
 * to the restricted profile because token metadata and successful interface
 * calls cannot rule out non-standard transfer behaviour.
 */
export function getTokenPolicyDecision(asset: TokenPolicyAsset, profile: TokenPolicyProfile): TokenPolicyDecision {
  if (!Number.isSafeInteger(asset.chainId) || asset.chainId <= 0 || !isAddress(asset.address)) {
    return { allowed: false, reason: 'invalid-token' }
  }

  if (!isSupportedChainId(asset.chainId)) {
    return { allowed: false, reason: 'chain-not-reviewed' }
  }

  if (profile === TokenPolicyProfile.ESTABLISHED_SETTLEMENT) {
    return { allowed: true, reason: 'approved' }
  }

  if (asset.chainId !== SupportedChainId.MAINNET) {
    return { allowed: false, reason: 'chain-not-reviewed' }
  }

  const approvedAssets =
    profile === TokenPolicyProfile.OTC_ESCROW ? OTC_ESCROW_ETHEREUM_ASSETS : APPROVED_ETHEREUM_ASSETS

  return approvedAssets.has(getAddressKey(asset.address))
    ? { allowed: true, reason: 'approved' }
    : { allowed: false, reason: 'token-not-reviewed' }
}

export function getCurrencyTokenPolicyDecision(currency: Currency, profile: TokenPolicyProfile): TokenPolicyDecision {
  return getTokenPolicyDecision({ chainId: currency.chainId, address: currency.wrapped.address }, profile)
}

export function isTradeAllowedByTokenPolicy(
  inputCurrency: Currency | null | undefined,
  outputCurrency: Currency | null | undefined,
  profile: TokenPolicyProfile,
): boolean {
  if (!inputCurrency || !outputCurrency) return false

  return (
    getCurrencyTokenPolicyDecision(inputCurrency, profile).allowed &&
    getCurrencyTokenPolicyDecision(outputCurrency, profile).allowed
  )
}

export function assertTradeTokenPolicy(
  inputAsset: TokenPolicyAsset,
  outputAsset: TokenPolicyAsset,
  profile: TokenPolicyProfile,
): void {
  const inputDecision = getTokenPolicyDecision(inputAsset, profile)
  const outputDecision = getTokenPolicyDecision(outputAsset, profile)

  if (!inputDecision.allowed || !outputDecision.allowed) {
    throw new Error(`Ophis token policy blocked this trade: ${inputDecision.reason}/${outputDecision.reason}`)
  }
}
