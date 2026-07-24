import { INTENT_STASH_KEY, clearIntentStash, readIntentStash, writeIntentStash } from './intentStash'

describe('intentStash', () => {
  beforeEach(() => {
    try {
      sessionStorage.clear()
    } catch {
      /* jsdom always provides sessionStorage */
    }
  })

  it('round-trips a stash and stamps ts', () => {
    writeIntentStash({ chainId: 10, sellToken: 'USDC', buyToken: 'ETH', amount: '100', field: 'sell' })
    const got = readIntentStash()
    expect(got).toMatchObject({ chainId: 10, sellToken: 'USDC', buyToken: 'ETH', amount: '100', field: 'sell' })
    expect(typeof got?.ts).toBe('number')
  })

  it('returns null when nothing is stashed', () => {
    expect(readIntentStash()).toBeNull()
  })

  it('clears the stash', () => {
    writeIntentStash({ sellToken: 'USDC', buyToken: 'ETH', field: 'sell' })
    clearIntentStash()
    expect(readIntentStash()).toBeNull()
  })

  it('expires a stale stash past the TTL', () => {
    // Write a stash with an old timestamp directly (bypassing writeIntentStash's Date.now()).
    sessionStorage.setItem(
      INTENT_STASH_KEY,
      JSON.stringify({ sellToken: 'USDC', buyToken: 'ETH', field: 'sell', ts: Date.now() - 60 * 60 * 1000 }),
    )
    expect(readIntentStash()).toBeNull()
    // ...but is still valid within a generous TTL.
    expect(readIntentStash(2 * 60 * 60 * 1000)).not.toBeNull()
  })

  it('rejects a stash with no tokens (nothing to route to)', () => {
    sessionStorage.setItem(INTENT_STASH_KEY, JSON.stringify({ amount: '100', field: 'sell', ts: Date.now() }))
    expect(readIntentStash()).toBeNull()
  })

  it('returns null (never throws) on malformed JSON', () => {
    sessionStorage.setItem(INTENT_STASH_KEY, '{not json')
    expect(readIntentStash()).toBeNull()
  })

  it('preserves a buy-only stash', () => {
    writeIntentStash({ chainId: 1, buyToken: 'COW', amount: '500', field: 'buy' })
    expect(readIntentStash()).toMatchObject({ chainId: 1, buyToken: 'COW', amount: '500', field: 'buy' })
  })

  it('defaults an unknown field to sell', () => {
    sessionStorage.setItem(
      INTENT_STASH_KEY,
      JSON.stringify({ sellToken: 'USDC', field: 'weird', ts: Date.now() }),
    )
    expect(readIntentStash()?.field).toBe('sell')
  })
})
