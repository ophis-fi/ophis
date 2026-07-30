import { legsQuoteSignature } from './quoteSignature'
import { DecomposedLeg } from './decomposition'

const A = '0x000000000000000000000000000000000000000a'
const B = '0x000000000000000000000000000000000000000b'
const C = '0x000000000000000000000000000000000000000c'

const leg = (sellToken: string, buyToken: string, sellAmount: bigint, sellIndex = 0, buyIndex = 0): DecomposedLeg => ({
  sellToken,
  buyToken,
  sellAmount,
  sellIndex,
  buyIndex,
})

describe('legsQuoteSignature', () => {
  it('is empty for a null leg set', () => {
    expect(legsQuoteSignature(null)).toBe('')
  })

  it('changes when a SELL token changes at the same slot/amount (invalidates the quote)', () => {
    const before = legsQuoteSignature([leg(A, B, 100n)])
    const after = legsQuoteSignature([leg(C, B, 100n)]) // same slot 0:0, same amount, different sell token
    expect(after).not.toBe(before)
  })

  it('changes when a BUY token changes at the same slot/amount (invalidates the quote)', () => {
    const before = legsQuoteSignature([leg(A, B, 100n)])
    const after = legsQuoteSignature([leg(A, C, 100n)])
    expect(after).not.toBe(before)
  })

  it('changes when the sell amount changes', () => {
    expect(legsQuoteSignature([leg(A, B, 100n)])).not.toBe(legsQuoteSignature([leg(A, B, 101n)]))
  })

  it('is stable across renders for the same tokens/amounts (only casing differs)', () => {
    const lower = legsQuoteSignature([leg(A, B, 100n)])
    const upper = legsQuoteSignature([leg(A.toUpperCase(), B.toUpperCase(), 100n)])
    expect(upper).toBe(lower) // token addresses are compared case-insensitively
  })
})
