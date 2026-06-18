import {
  OPHIS_PARTNER_FEE_RECIPIENT,
  OPHIS_DEFAULT_APP_DATA_PARTNER_FEE,
  OPHIS_DEFAULT_PARTNER_FEE,
  ophisAppDataPartnerFeeForChain,
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

  describe('ophisAppDataPartnerFeeForChain (price-improvement suppression on self-hosted chains)', () => {
    it('suppresses the price-improvement fallback on Optimism (10), the Volume-only self-hosted chain', () => {
      // The OP backend rejects the PI shape at ingress; emitting it would 400.
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
})
