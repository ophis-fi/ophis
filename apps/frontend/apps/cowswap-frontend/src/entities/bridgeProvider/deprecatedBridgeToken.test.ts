import { isDeprecatedBridgeToken } from './deprecatedBridgeToken'

describe('isDeprecatedBridgeToken', () => {
  it('flags the real NEAR Intents deprecated symbols (underscore + bare suffix)', () => {
    // Verbatim symbols served by the 1Click/HOT omni-bridge for Plasma (chain 9745)
    expect(isDeprecatedBridgeToken({ symbol: 'XPL_(DEPRECATED)' })).toBe(true)
    expect(isDeprecatedBridgeToken({ symbol: 'USDT0(DEPRECATED)' })).toBe(true)
  })

  it('is case-insensitive and tolerates internal spacing', () => {
    expect(isDeprecatedBridgeToken({ symbol: 'FOO (deprecated)' })).toBe(true)
    expect(isDeprecatedBridgeToken({ symbol: 'foo(Deprecated)' })).toBe(true)
    expect(isDeprecatedBridgeToken({ name: 'Old Token ( DEPRECATED )' })).toBe(true)
  })

  it('matches when only the name carries the marker', () => {
    expect(isDeprecatedBridgeToken({ symbol: 'XPL', name: 'XPL (deprecated)' })).toBe(true)
  })

  it('keeps the current, non-deprecated assets', () => {
    expect(isDeprecatedBridgeToken({ symbol: 'XPL', name: 'XPL' })).toBe(false)
    expect(isDeprecatedBridgeToken({ symbol: 'USDT0', name: 'USDT0' })).toBe(false)
    expect(isDeprecatedBridgeToken({ symbol: 'WXPL', name: 'Wrapped XPL' })).toBe(false)
  })

  it('does not match the bare word "deprecated" without the parenthesized marker', () => {
    expect(isDeprecatedBridgeToken({ name: 'Deprecation Protocol' })).toBe(false)
    expect(isDeprecatedBridgeToken({ symbol: 'DEPRECATED' })).toBe(false)
  })

  it('handles missing/null/empty fields', () => {
    expect(isDeprecatedBridgeToken({})).toBe(false)
    expect(isDeprecatedBridgeToken({ symbol: null, name: null })).toBe(false)
    expect(isDeprecatedBridgeToken({ symbol: '', name: '' })).toBe(false)
  })
})
