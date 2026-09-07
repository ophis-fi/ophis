import { isAddressEqual, maxUint256, type Address } from 'viem'

import { OTC_CANARY_POLICY } from './otcCanary.const'

import type { OtcCreateDraft, OtcWriteIntent } from './otcWrite.types'

export interface OtcCanaryPair {
  readonly tokenA: Address
  readonly tokenB: Address
  readonly maxAmountA: bigint
  readonly maxAmountB: bigint
}

export interface OtcCanaryPolicy {
  readonly accounts: readonly Address[]
  readonly pairs: readonly OtcCanaryPair[]
  readonly expiresAt: bigint
}

export function isOtcCanaryAccount(account: Address | undefined, policy: OtcCanaryPolicy = OTC_CANARY_POLICY): boolean {
  return !!account && policy.accounts.some((allowed) => isAddressEqual(allowed, account))
}

function validLimit(amount: bigint): boolean {
  return amount > 0n && amount <= maxUint256
}

/** Per-action token-unit caps cover both legs, in either direction; no price oracle is trusted. */
export function getOtcCanaryRestriction(
  intent: OtcWriteIntent,
  nowSeconds: bigint,
  policy: OtcCanaryPolicy = OTC_CANARY_POLICY,
): string | null {
  if (!isOtcCanaryAccount(intent.account, policy)) return 'This wallet is not in the OTC canary.'
  // Closing trading must not strand an admitted wallet's escrow or existing allowance.
  if (intent.kind === 'cancel' || intent.kind === 'revoke-create' || intent.kind === 'revoke-fill') return null
  if (nowSeconds < 0n || nowSeconds >= policy.expiresAt) return 'The OTC canary trading window is closed.'
  const terms = 'draft' in intent ? intent.draft : intent.order
  return pairRestriction(terms, policy)
}

function pairRestriction(terms: OtcCreateDraft, policy: OtcCanaryPolicy): string | null {
  const pair = policy.pairs.find(
    (candidate) =>
      (isAddressEqual(candidate.tokenA, terms.tokenA) && isAddressEqual(candidate.tokenB, terms.tokenB)) ||
      (isAddressEqual(candidate.tokenA, terms.tokenB) && isAddressEqual(candidate.tokenB, terms.tokenA)),
  )
  if (!pair) return 'This token pair is not in the OTC canary.'
  const forward = isAddressEqual(pair.tokenA, terms.tokenA)
  const maxA = forward ? pair.maxAmountA : pair.maxAmountB
  const maxB = forward ? pair.maxAmountB : pair.maxAmountA
  if (!validLimit(maxA) || !validLimit(maxB) || terms.amountA > maxA || terms.amountB > maxB) {
    return 'The order exceeds an OTC canary token amount limit.'
  }
  return null
}

export function assertOtcCanaryIntent(intent: OtcWriteIntent, nowSeconds: bigint): void {
  const restriction = getOtcCanaryRestriction(intent, nowSeconds)
  if (restriction) throw new Error(restriction)
}
