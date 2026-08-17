import { DAI, NATIVE_CURRENCY_ADDRESS, USDC_MAINNET, WETH_MAINNET } from '@cowprotocol/common-const'
import { isAddress } from '@cowprotocol/common-utils'
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

const APPROVED_ETHEREUM_ASSETS = new Set(
  [NATIVE_CURRENCY_ADDRESS, WETH_MAINNET.address, USDC_MAINNET.address, DAI.address].map(getAddressKey),
)

/**
 * Ophis token policy is deliberately allowlist-only. Token metadata and a
 * successful ERC-20 probe cannot rule out transfer taxes, rebases, callbacks,
 * blocklists, proxy changes, or deceptive return values.
 */
export function getTokenPolicyDecision(asset: TokenPolicyAsset): TokenPolicyDecision {
  if (!Number.isSafeInteger(asset.chainId) || asset.chainId <= 0 || !isAddress(asset.address)) {
    return { allowed: false, reason: 'invalid-token' }
  }

  if (asset.chainId !== SupportedChainId.MAINNET) {
    return { allowed: false, reason: 'chain-not-reviewed' }
  }

  return APPROVED_ETHEREUM_ASSETS.has(getAddressKey(asset.address))
    ? { allowed: true, reason: 'approved' }
    : { allowed: false, reason: 'token-not-reviewed' }
}

export function getCurrencyTokenPolicyDecision(currency: Currency): TokenPolicyDecision {
  return getTokenPolicyDecision({ chainId: currency.chainId, address: currency.wrapped.address })
}

export function isTradeAllowedByTokenPolicy(
  inputCurrency: Currency | null | undefined,
  outputCurrency: Currency | null | undefined,
): boolean {
  if (!inputCurrency || !outputCurrency) return false

  return getCurrencyTokenPolicyDecision(inputCurrency).allowed && getCurrencyTokenPolicyDecision(outputCurrency).allowed
}

export function assertTradeTokenPolicy(inputAsset: TokenPolicyAsset, outputAsset: TokenPolicyAsset): void {
  const inputDecision = getTokenPolicyDecision(inputAsset)
  const outputDecision = getTokenPolicyDecision(outputAsset)

  if (!inputDecision.allowed || !outputDecision.allowed) {
    throw new Error(`Ophis token policy blocked this trade: ${inputDecision.reason}/${outputDecision.reason}`)
  }
}
