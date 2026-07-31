import { readBasketTag } from './readBasketTag'

const ID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'

describe('readBasketTag', () => {
  it('reads a valid marker off a parsed appData doc', () => {
    expect(readBasketTag({ metadata: { ophisBasket: { id: ID, leg: 2, legs: 6 } } })).toEqual({
      id: ID,
      leg: 2,
      legs: 6,
    })
  })

  it('returns null when the order is not a basket leg', () => {
    expect(readBasketTag({ metadata: { orderClass: { orderClass: 'market' } } })).toBeNull()
    expect(readBasketTag({ metadata: {} })).toBeNull()
    expect(readBasketTag({})).toBeNull()
    expect(readBasketTag(null)).toBeNull()
    expect(readBasketTag('nope')).toBeNull()
  })

  it('treats a malformed / attacker-shaped marker as absent', () => {
    expect(readBasketTag({ metadata: { ophisBasket: { id: 'BAD', leg: 1, legs: 1 } } })).toBeNull()
    expect(readBasketTag({ metadata: { ophisBasket: { id: ID, leg: 0, legs: 3 } } })).toBeNull()
    expect(readBasketTag({ metadata: { ophisBasket: { id: ID, leg: 4, legs: 3 } } })).toBeNull() // leg > legs
    expect(readBasketTag({ metadata: { ophisBasket: { id: ID, leg: 1, legs: 99 } } })).toBeNull() // over cap
    expect(readBasketTag({ metadata: { ophisBasket: { id: ID, leg: 1.5, legs: 3 } } })).toBeNull()
    expect(readBasketTag({ metadata: { ophisBasket: { id: ID } } })).toBeNull()
  })
})
