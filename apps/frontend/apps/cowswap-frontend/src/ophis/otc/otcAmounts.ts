const RATE_PRECISION = 8

/**
 * Exact decimal rendering of an on-chain token amount. Pure bigint string
 * manipulation — on-chain values must never pass through floats.
 */
export function formatOtcAmount(amount: bigint, decimals: number): string {
  if (amount < 0n || !Number.isInteger(decimals) || decimals < 0) {
    throw new Error('Ophis OTC amount rejected')
  }

  const base = 10n ** BigInt(decimals)
  const integer = amount / base
  const fraction = amount % base
  if (fraction === 0n) return integer.toString()

  const fractionText = fraction.toString().padStart(decimals, '0').replace(/0+$/, '')
  return `${integer.toString()}.${fractionText}`
}

function divideToDecimal(numerator: bigint, denominator: bigint): string | null {
  const scaled = (numerator * 10n ** BigInt(RATE_PRECISION)) / denominator
  if (scaled === 0n) return null
  return formatOtcAmount(scaled, RATE_PRECISION)
}

export interface OtcRate {
  /** Unit-normalized amount of tokenB per 1 tokenA, truncated to 8 fraction digits. */
  rate: string
  /** Unit-normalized amount of tokenA per 1 tokenB, truncated to 8 fraction digits. */
  inverseRate: string
}

export function computeOtcRate(
  amountA: bigint,
  decimalsA: number,
  amountB: bigint,
  decimalsB: number,
): OtcRate | null {
  if (amountA <= 0n || amountB <= 0n) return null

  const unitScaleA = 10n ** BigInt(decimalsA)
  const unitScaleB = 10n ** BigInt(decimalsB)
  const rate = divideToDecimal(amountB * unitScaleA, amountA * unitScaleB)
  const inverseRate = divideToDecimal(amountA * unitScaleB, amountB * unitScaleA)
  if (rate === null || inverseRate === null) return null

  return { rate, inverseRate }
}
