import { formatRefCode } from './affiliateProgramUtils'

describe('formatRefCode', () => {
  it('normalizes and validates referral code', () => {
    expect(formatRefCode(' abcde ')).toBe('ABCDE')
  })

  it('accepts 3-char codes (partner codes, backend grammar {3,64})', () => {
    expect(formatRefCode('san')).toBe('SAN')
  })

  it('accepts 64-char codes', () => {
    expect(formatRefCode('A'.repeat(64))).toBe('A'.repeat(64))
  })

  it('rejects short codes', () => {
    expect(formatRefCode('AB')).toBeUndefined()
  })

  it('rejects long codes', () => {
    expect(formatRefCode('A'.repeat(65))).toBeUndefined()
  })

  it('rejects invalid characters', () => {
    expect(formatRefCode('ABCD!')).toBeUndefined()
  })
})
