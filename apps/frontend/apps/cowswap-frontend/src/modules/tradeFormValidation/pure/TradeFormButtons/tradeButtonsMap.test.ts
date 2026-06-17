import { BridgeQuoteErrors } from '@cowprotocol/sdk-bridging'

import { getBridgeQuoteErrorTexts } from './tradeButtonsMap'

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
