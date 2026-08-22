import { DAI, USDC_MAINNET, WETH_MAINNET } from '@cowprotocol/common-const'

import { isAddressEqual, parseUnits, type Address } from 'viem'

import type { OtcCreateDraft } from './otcWrite.types'

export interface OtcReviewedToken {
  address: Address
  symbol: string
  name: string
  decimals: number
}

export const OTC_REVIEWED_TOKENS: readonly OtcReviewedToken[] = Object.freeze([
  { address: WETH_MAINNET.address, symbol: 'WETH', name: 'Wrapped Ether', decimals: WETH_MAINNET.decimals },
  { address: USDC_MAINNET.address, symbol: 'USDC', name: 'USD Coin', decimals: USDC_MAINNET.decimals },
  { address: DAI.address, symbol: 'DAI', name: 'Dai Stablecoin', decimals: DAI.decimals },
])

export function reviewedOtcToken(address: Address): OtcReviewedToken | null {
  return OTC_REVIEWED_TOKENS.find((token) => isAddressEqual(token.address, address)) ?? null
}

const HUMAN_AMOUNT = /^(?:0|[1-9]\d*)(?:\.\d+)?$/
const MAX_HUMAN_AMOUNT_LENGTH = 80
const UINT256_MAX = 2n ** 256n - 1n

function hasValidPrecision(normalized: string, decimals: number): boolean {
  if (!Number.isInteger(decimals)) return false
  if (decimals < 0) return false
  const fraction = normalized.split('.')[1]
  return (fraction?.length ?? 0) <= decimals
}

export function parseOtcHumanAmount(value: string, decimals: number): bigint | null {
  const normalized = value.trim()
  if (normalized.length > MAX_HUMAN_AMOUNT_LENGTH) return null
  if (!HUMAN_AMOUNT.test(normalized)) return null
  if (!hasValidPrecision(normalized, decimals)) return null
  try {
    const amount = parseUnits(normalized, decimals)
    if (amount <= 0n || amount > UINT256_MAX) return null
    return amount
  } catch {
    return null
  }
}

export interface OtcCreateFormValues {
  tokenA: OtcReviewedToken
  amountA: string
  tokenB: OtcReviewedToken
  amountB: string
}

export function parseOtcCreateDraft(values: OtcCreateFormValues): OtcCreateDraft | null {
  if (isAddressEqual(values.tokenA.address, values.tokenB.address)) return null
  const amountA = parseOtcHumanAmount(values.amountA, values.tokenA.decimals)
  const amountB = parseOtcHumanAmount(values.amountB, values.tokenB.decimals)
  if (amountA === null || amountB === null) return null
  return { tokenA: values.tokenA.address, amountA, tokenB: values.tokenB.address, amountB }
}
