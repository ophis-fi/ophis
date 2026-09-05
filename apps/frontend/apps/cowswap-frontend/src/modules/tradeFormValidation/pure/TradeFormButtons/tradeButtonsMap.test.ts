import { BridgeQuoteErrors } from '@cowprotocol/sdk-bridging'

import { getBridgeQuoteErrorTexts, getBridgeSameTokenErrorText } from './tradeButtonsMap'

// The NEAR Intents deposit-address attestation provably works (it recovers the expected
// on-chain attestor); QUOTE_DOES_NOT_MATCH_DEPOSIT_ADDRESS in practice is a transient
// attestation-fetch hiccup, and the bridging SDK already falls back to any other provider
// with a valid quote. So the UI must NOT scare the user with an alarming, non-actionable
// "deposit address is not verified / contact support" message for this transient state.
describe('getBridgeQuoteErrorTexts > QUOTE_DOES_NOT_MATCH_DEPOSIT_ADDRESS', () => {
  it('is not surfaced as an alarming "not verified / contact support" message', () => {
    const text = getBridgeQuoteErrorTexts()[BridgeQuoteErrors.QUOTE_DOES_NOT_MATCH_DEPOSIT_ADDRESS].toLowerCase()

    expect(text).not.toContain('contact')
    expect(text).not.toContain('support')
    expect(text).not.toContain('not verified')
  })

  it('is reclassified as a transient, retry-able provider error (same copy as API_ERROR)', () => {
    const texts = getBridgeQuoteErrorTexts()

    expect(texts[BridgeQuoteErrors.QUOTE_DOES_NOT_MATCH_DEPOSIT_ADDRESS]).toBe(texts[BridgeQuoteErrors.API_ERROR])
  })
})

// Robinhood 4663 bridge testing, 2026-08-27: selling ETH there to receive WETH on
// Unichain failed with SameBuyAndSellToken (native ETH and WETH share one address
// on 4663, so the only intermediate WAS the sell token). The button read
// "No routes found", which reads as "this corridor is dead" — it sent us hunting
// for a different NETWORK when every network behaved the same way and the actual
// fix was to pick a different destination TOKEN (ETH -> USDC bridged fine).
describe('getBridgeSameTokenErrorText', () => {
  it('tells the user to change the destination TOKEN when the two sides look different', () => {
    const text = getBridgeSameTokenErrorText(true)

    expect(text.toLowerCase()).toContain('token')
    // The old copy; it misdirects to the network picker.
    expect(text.toLowerCase()).not.toContain('no routes')
  })

  it('keeps the plain "not yet supported" copy when the user picked the same asset on both sides', () => {
    expect(getBridgeSameTokenErrorText(false).toLowerCase()).toContain('not yet supported')
  })

  it('never reuses the generic NO_ROUTES copy for this error', () => {
    const noRoutes = getBridgeQuoteErrorTexts()[BridgeQuoteErrors.NO_ROUTES]

    expect(getBridgeSameTokenErrorText(true)).not.toBe(noRoutes)
    expect(getBridgeSameTokenErrorText(false)).not.toBe(noRoutes)
  })
})
