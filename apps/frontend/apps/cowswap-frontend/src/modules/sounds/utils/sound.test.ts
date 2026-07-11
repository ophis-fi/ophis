jest.mock('@cowprotocol/core', () => ({
  jotaiStore: { get: jest.fn() },
}))

import { __soundTestUtils } from './sound'

describe('getThemeBasedSound', () => {
  const getThemeBasedSound = __soundTestUtils.getThemeBasedSound

  it('returns the default Ophis send sound', () => {
    expect(getThemeBasedSound('SEND')).toBe('/audio/send.mp3')
  })

  it('returns the branded Ophis swap-completion sound', () => {
    expect(getThemeBasedSound('SUCCESS')).toBe('/audio/lalala.mp3')
  })

  it('returns the default Ophis error sound', () => {
    expect(getThemeBasedSound('ERROR')).toBe('/audio/error.mp3')
  })
})
