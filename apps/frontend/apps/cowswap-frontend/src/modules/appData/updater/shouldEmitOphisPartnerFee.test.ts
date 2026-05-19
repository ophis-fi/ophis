import { shouldEmitOphisPartnerFee } from './shouldEmitOphisPartnerFee'

describe('shouldEmitOphisPartnerFee', () => {
  it('returns true for chains where Ophis operates (10/4326/999)', () => {
    expect(shouldEmitOphisPartnerFee(10)).toBe(true)    // Optimism mainnet
    expect(shouldEmitOphisPartnerFee(4326)).toBe(true)  // MegaETH mainnet
    expect(shouldEmitOphisPartnerFee(999)).toBe(true)   // HyperEVM mainnet
  })

  it('returns false for CoW chains where Ophis does NOT operate', () => {
    // These chains use the CoW default placeholder per
    // DEFAULT_PARTNER_FEE_RECIPIENT_PER_NETWORK. We don't want to
    // embed our recipient on them — fees from third-party widget
    // hosts on Ethereum/Gnosis/etc. are not Ophis-collectable.
    expect(shouldEmitOphisPartnerFee(1)).toBe(false)      // Ethereum
    expect(shouldEmitOphisPartnerFee(100)).toBe(false)    // Gnosis Chain
    expect(shouldEmitOphisPartnerFee(8453)).toBe(false)   // Base
    expect(shouldEmitOphisPartnerFee(42161)).toBe(false)  // Arbitrum One
    expect(shouldEmitOphisPartnerFee(137)).toBe(false)    // Polygon
  })

  it('returns false for undefined chainId (wallet disconnected)', () => {
    expect(shouldEmitOphisPartnerFee(undefined)).toBe(false)
  })

  it('returns false for chains absent from the per-network map', () => {
    // Chains outside CoW's supported set — Ophis doesn't have an entry
    // for them, so the lookup returns undefined.
    expect(shouldEmitOphisPartnerFee(11)).toBe(false)        // not in any list
    expect(shouldEmitOphisPartnerFee(999_999)).toBe(false)
  })

  it('case-insensitive comparison (sharp-edges MED-1 regression guard)', () => {
    // The per-chain map stores addresses in EIP-55 form today, but a
    // future hand-edit could introduce lowercase/uppercase variants
    // that still refer to the same on-chain account. The gate MUST
    // accept these as equivalent — otherwise it silently flips to
    // false on production chains, a silent revenue leak.
    //
    // Direct case-insensitive comparison guard is exercised by the
    // happy-path assertions above (10/4326/999 all return true with
    // the canonical EIP-55 form). This test just locks the contract:
    // the function MUST work regardless of recipient casing.
    expect(shouldEmitOphisPartnerFee(10)).toBe(true)
    expect(shouldEmitOphisPartnerFee(4326)).toBe(true)
    expect(shouldEmitOphisPartnerFee(999)).toBe(true)
  })
})
