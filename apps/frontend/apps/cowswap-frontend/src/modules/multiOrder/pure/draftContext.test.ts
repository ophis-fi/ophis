import { isDraftForContext } from './draftContext'
import { BasketDraft } from '../types'

const OWNER = '0x1111111111111111111111111111111111111111'
const OTHER = '0x2222222222222222222222222222222222222222'

const draft: BasketDraft = {
  id: 'a'.repeat(32),
  owner: OWNER,
  chainId: 10,
  validTo: 1_800_000_000,
  tier: 'stepped',
  legs: [],
}

describe('isDraftForContext', () => {
  it('true for the same account (case-insensitive) and chain', () => {
    expect(isDraftForContext(draft, OWNER, 10)).toBe(true)
    expect(isDraftForContext(draft, OWNER.toUpperCase(), 10)).toBe(true)
  })

  it('false when the account changed', () => {
    expect(isDraftForContext(draft, OTHER, 10)).toBe(false)
  })

  it('false when the chain changed', () => {
    expect(isDraftForContext(draft, OWNER, 8453)).toBe(false)
  })

  it('false with no draft / no owner / no chain', () => {
    expect(isDraftForContext(null, OWNER, 10)).toBe(false)
    expect(isDraftForContext(draft, undefined, 10)).toBe(false)
    expect(isDraftForContext(draft, OWNER, undefined)).toBe(false)
  })
})
