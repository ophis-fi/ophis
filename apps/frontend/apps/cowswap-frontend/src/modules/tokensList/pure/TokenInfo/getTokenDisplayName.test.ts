import { getTokenDisplayName } from './getTokenDisplayName.utils'

describe('getTokenDisplayName', () => {
  it.each([
    ['American Airlines Group (Ondo Tokenized)', ['ondo'], 'American Airlines Group'],
    ['Apple (Ondo Tokenized Stock)', ['ondo'], 'Apple'],
    ['Apple xStock', ['xStocks'], 'Apple'],
    ['Bank Of China xStock', ['xStocks'], 'Bank Of China'],
  ])('removes duplicated provider wording from %s', (name, tags, expected) => {
    expect(getTokenDisplayName(name, tags)).toBe(expected)
  })

  it('does not alter similarly named assets without the provider tag', () => {
    expect(getTokenDisplayName('Example xStock', [])).toBe('Example xStock')
    expect(getTokenDisplayName('Example (Ondo Tokenized)', [])).toBe('Example (Ondo Tokenized)')
  })

  it('uses verified list membership when merged metadata lost the provider tag', () => {
    expect(getTokenDisplayName('Apple (Ondo Tokenized Stock)', [], 'ondo')).toBe('Apple')
    expect(getTokenDisplayName('Apple xStock', [], 'xStocks')).toBe('Apple')
  })

  it('handles missing token names', () => {
    expect(getTokenDisplayName(undefined, [], undefined)).toBe('')
  })
})
