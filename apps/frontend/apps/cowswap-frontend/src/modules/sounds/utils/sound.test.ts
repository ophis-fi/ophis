jest.mock('@cowprotocol/core', () => ({
  jotaiStore: { get: jest.fn() },
}))

import { __soundTestUtils } from './sound'

describe('getThemeBasedSound', () => {
  const getThemeBasedSound = __soundTestUtils.getThemeBasedSound

  it('returns the default Greg send sound', () => {
    expect(getThemeBasedSound('SEND')).toBe('/audio/send.mp3')
  })

  it('returns the default Greg success sound', () => {
    expect(getThemeBasedSound('SUCCESS')).toBe('/audio/success.mp3')
  })

  it('returns the default Greg error sound', () => {
    expect(getThemeBasedSound('ERROR')).toBe('/audio/error.mp3')
  })
})
