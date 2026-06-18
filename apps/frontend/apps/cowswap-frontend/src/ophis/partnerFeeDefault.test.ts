import {
  OPHIS_PARTNER_FEE_RECIPIENT,
  OPHIS_DEFAULT_APP_DATA_PARTNER_FEE,
  OPHIS_DEFAULT_PARTNER_FEE,
  ophisAppDataPartnerFeeForChain,
  ophisVolumeOnlyFloorFee,
  isVolumeOnlyChain,
} from './partnerFeeDefault'

/**
 * Cross-file drift guard (Phase 3 audit H1, Codex pre-PR MED-1).
 * See `apps/frontend/libs/common-const/src/feeRecipient.test.ts` for full
 * rationale. If this canonical address changes, update all 3 sites in
 * the same PR:
 *   - this file
 *   - apps/frontend/libs/common-const/src/feeRecipient.test.ts
 *   - packages/sdk/tests/partner-fee.test.ts
 */
const CANONICAL_OPHIS_PARTNER_FEE_RECIPIENT = '0x858f0F5eE954846D47155F5203c04aF1819eCeF8'

describe('partnerFeeDefault', () => {
  it('OPHIS_PARTNER_FEE_RECIPIENT equals the canonical literal (cross-file drift guard)', () => {
    expect(OPHIS_PARTNER_FEE_RECIPIENT).toBe(CANONICAL_OPHIS_PARTNER_FEE_RECIPIENT)
  })

  it('OPHIS_DEFAULT_PARTNER_FEE.recipient matches the canonical recipient', () => {
    expect(OPHIS_DEFAULT_PARTNER_FEE.recipient).toBe(CANONICAL_OPHIS_PARTNER_FEE_RECIPIENT)
  })

  it('OPHIS_DEFAULT_APP_DATA_PARTNER_FEE.recipient matches the canonical recipient', () => {
    expect(OPHIS_DEFAULT_APP_DATA_PARTNER_FEE.recipient).toBe(CANONICAL_OPHIS_PARTNER_FEE_RECIPIENT)
  })

  it('OPHIS_DEFAULT_APP_DATA_PARTNER_FEE carries the spec-mandated price-improvement bps + maxVolumeBps', () => {
    // CIP-75 priceImprovementBps:2500 maxVolumeBps:50 — partner-fee spec.
    expect(OPHIS_DEFAULT_APP_DATA_PARTNER_FEE.priceImprovementBps).toBe(2500)
    expect(OPHIS_DEFAULT_APP_DATA_PARTNER_FEE.maxVolumeBps).toBe(50)
  })

  describe('ophisAppDataPartnerFeeForChain (PI suppression on self-hosted chains)', () => {
    it('suppresses the PI fallback on Optimism (10) (returns undefined; the floor is carried by the volumeFee pipeline so display == charged)', () => {
      // On OP the backend rejects the PI shape at ingress; the floor Volume fee is
      // emitted from the single volumeFee source (ophisVolumeOnlyFloorFee) so the
      // displayed fee and the appData fee match. The PI fallback is just suppressed.
      expect(ophisAppDataPartnerFeeForChain(OPHIS_DEFAULT_APP_DATA_PARTNER_FEE, 10)).toBeUndefined()
    })

    it('passes the price-improvement fallback through on CoW-hosted chains (e.g. mainnet 1, base 8453)', () => {
      expect(ophisAppDataPartnerFeeForChain(OPHIS_DEFAULT_APP_DATA_PARTNER_FEE, 1)).toBe(
        OPHIS_DEFAULT_APP_DATA_PARTNER_FEE,
      )
      expect(ophisAppDataPartnerFeeForChain(OPHIS_DEFAULT_APP_DATA_PARTNER_FEE, 8453)).toBe(
        OPHIS_DEFAULT_APP_DATA_PARTNER_FEE,
      )
    })

    it('passes through undefined (flag-on path already emits no PI fee) regardless of chain', () => {
      expect(ophisAppDataPartnerFeeForChain(undefined, 10)).toBeUndefined()
      expect(ophisAppDataPartnerFeeForChain(undefined, 1)).toBeUndefined()
    })

    it('passes through when chainId is undefined (AppDataUpdater bails on no chain anyway)', () => {
      expect(ophisAppDataPartnerFeeForChain(OPHIS_DEFAULT_APP_DATA_PARTNER_FEE, undefined)).toBe(
        OPHIS_DEFAULT_APP_DATA_PARTNER_FEE,
      )
    })
  })

  describe('ophisVolumeOnlyFloorFee (single OP floor source for display + appData)', () => {
    it('returns the 10 bps non-stable floor Volume fee on Optimism', () => {
      expect(ophisVolumeOnlyFloorFee(10, false)).toEqual({
        volumeBps: 10,
        recipient: CANONICAL_OPHIS_PARTNER_FEE_RECIPIENT,
      })
    })

    it('returns the reduced 1 bp floor on Optimism for a stable / boosted pair', () => {
      expect(ophisVolumeOnlyFloorFee(10, true)).toEqual({
        volumeBps: 1,
        recipient: CANONICAL_OPHIS_PARTNER_FEE_RECIPIENT,
      })
    })

    it('returns undefined off the Volume-only chains (CoW-hosted + no chain)', () => {
      expect(ophisVolumeOnlyFloorFee(1, false)).toBeUndefined()
      expect(ophisVolumeOnlyFloorFee(8453, true)).toBeUndefined()
      expect(ophisVolumeOnlyFloorFee(undefined, false)).toBeUndefined()
    })

    it('isVolumeOnlyChain is true only for Optimism (10)', () => {
      expect(isVolumeOnlyChain(10)).toBe(true)
      expect(isVolumeOnlyChain(1)).toBe(false)
      expect(isVolumeOnlyChain(8453)).toBe(false)
      expect(isVolumeOnlyChain(undefined)).toBe(false)
    })
  })
})
