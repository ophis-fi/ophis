import { readIntentParam, MAX_INTENT_PREFILL_LEN } from './intentParam'

describe('readIntentParam', () => {
  it('reads and trims the intent from a query string', () => {
    expect(readIntentParam('?intent=swap%20100%20USDC%20for%20ETH')).toBe('swap 100 USDC for ETH')
    expect(readIntentParam('intent=%20%20buy%20eth%20%20')).toBe('buy eth')
  })

  it('returns empty string when the param is absent, blank, or the query is empty', () => {
    expect(readIntentParam('?foo=bar')).toBe('')
    expect(readIntentParam('?intent=')).toBe('')
    expect(readIntentParam('?intent=%20%20')).toBe('')
    expect(readIntentParam('')).toBe('')
    expect(readIntentParam(null, undefined)).toBe('')
  })

  it('prefers the first non-empty source (hash-router query, then pre-hash search)', () => {
    // hash-router query wins when present
    expect(readIntentParam('?intent=from-hash', '?intent=from-search')).toBe('from-hash')
    // falls back to the later source when the earlier one has no usable intent
    expect(readIntentParam('?other=x', '?intent=from-search')).toBe('from-search')
    expect(readIntentParam('', '?intent=from-search')).toBe('from-search')
  })

  it('caps the length to the parser limit so an over-long link cannot inflate the request', () => {
    const long = 'a'.repeat(MAX_INTENT_PREFILL_LEN + 50)
    expect(readIntentParam(`?intent=${long}`)).toHaveLength(MAX_INTENT_PREFILL_LEN)
  })
})
