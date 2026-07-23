import { appendRefToShareText, OPHIS_SWAP_ORIGIN } from './helpers'

describe('appendRefToShareText', () => {
  const message = `Swap on Ophis. ${OPHIS_SWAP_ORIGIN}`

  it('rewrites the swap link to carry the referral code', () => {
    expect(appendRefToShareText(message, 'acme')).toBe(`Swap on Ophis. ${OPHIS_SWAP_ORIGIN}/?ref=acme`)
  })

  it('is a no-op without a code (share falls back to the plain link)', () => {
    expect(appendRefToShareText(message, undefined)).toBe(message)
    expect(appendRefToShareText(message, '')).toBe(message)
  })

  it('leaves a message without the swap origin untouched', () => {
    const other = 'no link here'
    expect(appendRefToShareText(other, 'acme')).toBe(other)
  })

  it('url-encodes the code so a share link is always well-formed', () => {
    // Codes are validated to [a-z0-9_-] upstream, but encode defensively so a
    // stray character can never break the link or inject query params.
    expect(appendRefToShareText(message, 'a b&c')).toBe(`Swap on Ophis. ${OPHIS_SWAP_ORIGIN}/?ref=a%20b%26c`)
  })

  it('only rewrites the first occurrence (the single link in the copy)', () => {
    const twice = `${OPHIS_SWAP_ORIGIN} and again ${OPHIS_SWAP_ORIGIN}`
    expect(appendRefToShareText(twice, 'acme')).toBe(`${OPHIS_SWAP_ORIGIN}/?ref=acme and again ${OPHIS_SWAP_ORIGIN}`)
  })
})
