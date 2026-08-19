import { getTokenDisplayName } from './getTokenDisplayName.utils'

describe('getTokenDisplayName', () => {
  it.each([
    ['American Airlines Group (Ondo Tokenized)', 'ondo', 'American Airlines Group'],
    ['Apple (Ondo Tokenized Stock)', 'ondo', 'Apple'],
    ['Apple xStock', 'xStocks', 'Apple'],
    ['Bank Of China xStock', 'xStocks', 'Bank Of China'],
  ] as const)('removes duplicated provider wording from %s', (name, provider, expected) => {
    expect(getTokenDisplayName(name, provider)).toBe(expected)
  })

  it('does not trust raw provider-like names without validated provider metadata', () => {
    expect(getTokenDisplayName('Example xStock', undefined)).toBe('Example xStock')
    expect(getTokenDisplayName('Example (Ondo Tokenized)', undefined)).toBe('Example (Ondo Tokenized)')
  })

  it('handles missing token names', () => {
    expect(getTokenDisplayName(undefined, undefined)).toBe('')
  })
})
