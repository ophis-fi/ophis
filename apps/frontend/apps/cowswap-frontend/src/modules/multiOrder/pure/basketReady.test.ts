import { allLegsQuoted, canConfirmBasket, isLegQuoted } from './basketReady'
import { BasketDraft, BasketLeg } from '../types'

const leg = (n: number, buyAmount?: string): BasketLeg => ({
  sellToken: '0x000000000000000000000000000000000000000a',
  buyToken: '0x000000000000000000000000000000000000000b',
  sellAmount: 100n,
  sellIndex: 0,
  buyIndex: n - 1,
  leg: n,
  status: 'pending',
  buyAmount,
})

const draft = (legs: BasketLeg[]): BasketDraft => ({
  id: 'a'.repeat(32),
  owner: '0x1111111111111111111111111111111111111111',
  chainId: 10,
  validTo: 1_800_000_000,
  tier: 'stepped',
  legs,
})

describe('isLegQuoted / allLegsQuoted', () => {
  it('a leg with a non-empty buyAmount is quoted', () => {
    expect(isLegQuoted({ buyAmount: '1000' })).toBe(true)
    expect(isLegQuoted({ buyAmount: undefined })).toBe(false)
    expect(isLegQuoted({ buyAmount: '' })).toBe(false)
  })

  it('allLegsQuoted requires EVERY leg to have a validated quote', () => {
    expect(allLegsQuoted([leg(1, '10'), leg(2, '20')])).toBe(true)
    expect(allLegsQuoted([leg(1, '10'), leg(2, undefined)])).toBe(false) // one still loading/failed
    expect(allLegsQuoted([])).toBe(false)
  })
})

describe('canConfirmBasket', () => {
  it('allows confirm only when every leg is quoted and no placement is running', () => {
    expect(canConfirmBasket(draft([leg(1, '10'), leg(2, '20')]), false)).toBe(true)
  })

  it('blocks confirm while a quote is still loading or failed (undefined buyAmount)', () => {
    expect(canConfirmBasket(draft([leg(1, '10'), leg(2, undefined)]), false)).toBe(false)
  })

  it('blocks confirm while a placement is running', () => {
    expect(canConfirmBasket(draft([leg(1, '10'), leg(2, '20')]), true)).toBe(false)
  })

  it('blocks confirm with no active draft', () => {
    expect(canConfirmBasket(null, false)).toBe(false)
  })
})
