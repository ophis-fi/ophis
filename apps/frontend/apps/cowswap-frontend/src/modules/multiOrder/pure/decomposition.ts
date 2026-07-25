/**
 * Basket decomposition: the remainder-exact bigint math at the heart of the
 * "ophis-multi-order" flow.
 *
 * A basket is N sell tokens x M buy tokens. This module turns that composition
 * into a flat list of single-pair GPv2 legs (sellToken -> buyToken, each with an
 * exact sellAmount), enforcing the caps (<= 6 sells, <= 6 buys, <= 6 legs).
 *
 * The ONE invariant that must never break: for every sell input, the atoms it
 * contributes across its legs sum to EXACTLY its input amount. Atoms are
 * indivisible; a naive `amount * weight / total` per leg silently drops or mints
 * dust on uneven splits, which would either strand user funds or sign an order
 * the wallet cannot fund. We use the largest-remainder (Hamilton) method on
 * bigints so the parts provably sum to the total, with the leftover atoms handed
 * to the largest fractional remainders (ties broken by lowest index) for a
 * deterministic, fair distribution.
 *
 * Pure: no React, no wallet, no network. Unit-tested in isolation.
 */
import { MAX_BASKET_LEGS, MAX_BASKET_SELL_TOKENS, MAX_BASKET_BUY_TOKENS } from 'ophis/basketMetadata'

/** One sell input: a token and the EXACT atom amount (uint256 decimal string) sold. */
export interface BasketSellInput {
  readonly token: string
  readonly amount: string
}

/** One buy output: a token and a positive relative weight (any unit; only ratios matter). */
export interface BasketBuyInput {
  readonly token: string
  readonly weight: bigint
}

/** A single-pair leg produced by decomposition. `sellAmount` is exact atoms. */
export interface DecomposedLeg {
  readonly sellToken: string
  readonly buyToken: string
  readonly sellAmount: bigint
  /** Index of the sell input this leg draws from (0-based). */
  readonly sellIndex: number
  /** Index of the buy output this leg targets (0-based). */
  readonly buyIndex: number
}

/**
 * Split `total` atoms across `weights` so the parts sum to EXACTLY `total`
 * (largest-remainder method).
 *
 * - floor_j    = total * w_j / W        (W = sum of weights)
 * - remainder  = total - sum(floor_j)   (0 <= remainder < count of positive weights)
 * - the `remainder` leftover atoms go to the parts with the largest fractional
 *   remainder (total*w_j mod W), ties broken by lowest index.
 *
 * Zero-weight parts always receive 0. `total` of 0 yields all zeros. Throws on a
 * negative total, an empty weight list, a negative weight, or an all-zero weight
 * sum (an undefined split).
 */
export function splitAmountExact(total: bigint, weights: readonly bigint[]): bigint[] {
  if (total < 0n) throw new Error('splitAmountExact: total must be >= 0')
  if (weights.length === 0) throw new Error('splitAmountExact: need at least one weight')

  let weightSum = 0n
  for (const w of weights) {
    if (w < 0n) throw new Error('splitAmountExact: weights must be >= 0')
    weightSum += w
  }
  if (weightSum === 0n) throw new Error('splitAmountExact: weight sum must be > 0')

  const parts: bigint[] = []
  // Fractional remainders (total*w_j mod W), carried alongside the index so we
  // can hand the leftover atoms to the largest ones deterministically.
  const fractions: { index: number; frac: bigint }[] = []
  let allocated = 0n
  weights.forEach((w, j) => {
    const numer = total * w
    const floor = numer / weightSum
    parts.push(floor)
    allocated += floor
    fractions.push({ index: j, frac: numer - floor * weightSum })
  })

  let remainder = total - allocated // exact leftover atoms, 0 <= remainder < positive-weight count
  if (remainder > 0n) {
    // Largest fractional remainder first; ties -> lowest index. A zero-weight part
    // has frac 0 and sorts last, so it never receives a leftover atom.
    fractions.sort((a, b) => (a.frac === b.frac ? a.index - b.index : a.frac > b.frac ? -1 : 1))
    for (const { index } of fractions) {
      if (remainder <= 0n) break
      parts[index] = (parts[index] ?? 0n) + 1n
      remainder -= 1n
    }
  }
  return parts
}

/**
 * Parse an exact uint256 atom amount from a decimal string. Rejects every
 * spelling of a non-positive or non-integer amount (mirrors the SDK's
 * assertAtoms), so a basket never carries an unsignable leg.
 */
function parseAtoms(amount: string, label: string): bigint {
  if (typeof amount !== 'string' || !/^[0-9]+$/.test(amount)) {
    throw new Error(`${label}: must be a positive integer string of atoms, got "${amount}"`)
  }
  const value = BigInt(amount)
  if (value <= 0n) throw new Error(`${label}: must be > 0, got "${amount}"`)
  if (value > MAX_UINT256) throw new Error(`${label}: exceeds uint256 max`)
  return value
}

const MAX_UINT256 = (1n << 256n) - 1n

export interface BasketComposition {
  readonly sells: readonly BasketSellInput[]
  readonly buys: readonly BasketBuyInput[]
}

/**
 * Decompose an N sell x M buy basket into single-pair legs.
 *
 * Each sell input's amount is split across the M buy outputs by their weights
 * (splitAmountExact, so per-sell atoms are conserved). Every non-zero (sell, buy)
 * cell becomes a leg. Legs are emitted sell-major then buy-order (deterministic).
 * Zero-amount cells are dropped (a 0-atom order is unsignable), so a lopsided
 * split against many buys yields fewer legs than N*M.
 *
 * Caps (owner decision 39 + spec 4.10): at most MAX_BASKET_SELL_TOKENS sells,
 * MAX_BASKET_BUY_TOKENS buys, and MAX_BASKET_LEGS surviving legs. A composition
 * whose non-zero legs would exceed the leg cap throws (the composer keeps the
 * user under it). This is why a dense 6x6 grid is out of Phase A scope: its 36
 * legs exceed the 6-leg budget. The supported shapes are one-to-many (fan-out),
 * many-to-one (fan-in), and small grids with <= 6 legs.
 */
export function decomposeBasket(composition: BasketComposition): DecomposedLeg[] {
  const { sells, buys } = composition
  if (sells.length < 1 || sells.length > MAX_BASKET_SELL_TOKENS) {
    throw new Error(`basket: sells must be 1..${MAX_BASKET_SELL_TOKENS}, got ${sells.length}`)
  }
  if (buys.length < 1 || buys.length > MAX_BASKET_BUY_TOKENS) {
    throw new Error(`basket: buys must be 1..${MAX_BASKET_BUY_TOKENS}, got ${buys.length}`)
  }
  for (const b of buys) {
    if (typeof b.weight !== 'bigint' || b.weight <= 0n) {
      throw new Error('basket: every buy weight must be a positive bigint')
    }
  }
  // No sell token may equal a buy token (a self-swap leg is meaningless and the
  // orderbook rejects sellToken == buyToken).
  const buyTokens = new Set(buys.map((b) => b.token.toLowerCase()))
  for (const s of sells) {
    if (buyTokens.has(s.token.toLowerCase())) {
      throw new Error(`basket: sell token ${s.token} also appears as a buy token`)
    }
  }

  const weights = buys.map((b) => b.weight)
  const legs: DecomposedLeg[] = []
  sells.forEach((sell, i) => {
    const amount = parseAtoms(sell.amount, `sells[${i}].amount`)
    const shares = splitAmountExact(amount, weights)
    // Exactness guard: the shares MUST reconstitute this sell's full amount.
    // Cheap, and it converts any future math regression into a loud throw rather
    // than a silently mis-funded order.
    let reconstituted = 0n
    for (const share of shares) reconstituted += share
    if (reconstituted !== amount) {
      throw new Error(`basket: split of sells[${i}] lost atoms (bug): ${reconstituted} != ${amount}`)
    }
    buys.forEach((buy, j) => {
      const share = shares[j] ?? 0n
      if (share === 0n) return // drop unsignable zero-amount legs
      legs.push({ sellToken: sell.token, buyToken: buy.token, sellAmount: share, sellIndex: i, buyIndex: j })
    })
  })

  if (legs.length < 1) throw new Error('basket: decomposition produced no legs')
  if (legs.length > MAX_BASKET_LEGS) {
    throw new Error(
      `basket: ${legs.length} legs exceeds the ${MAX_BASKET_LEGS}-leg cap. Reduce the number of sell or buy tokens.`,
    )
  }
  return legs
}

/**
 * Total sell atoms across all inputs, for the global sum-equals-total assertion
 * (the decomposed legs' sellAmounts must sum to this).
 */
export function totalSellAtoms(composition: BasketComposition): bigint {
  let sum = 0n
  for (const s of composition.sells) sum += parseAtoms(s.amount, 'sell amount')
  return sum
}
