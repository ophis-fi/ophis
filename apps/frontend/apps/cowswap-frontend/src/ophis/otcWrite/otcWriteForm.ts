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

export function parseOtcHumanAmount(value: string, decimals: number): bigint | null {
  const normalized = value.trim()
  if (!HUMAN_AMOUNT.test(normalized)) return null
  const fraction = normalized.split('.')[1]
  if (!Number.isInteger(decimals) || decimals < 0 || (fraction?.length ?? 0) > decimals) return null
  try {
    const amount = parseUnits(normalized, decimals)
    return amount > 0n ? amount : null
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
  if (values.tokenA.address === values.tokenB.address) return null
  const amountA = parseOtcHumanAmount(values.amountA, values.tokenA.decimals)
  const amountB = parseOtcHumanAmount(values.amountB, values.tokenB.decimals)
  if (amountA === null || amountB === null) return null
  return { tokenA: values.tokenA.address, amountA, tokenB: values.tokenB.address, amountB }
}
