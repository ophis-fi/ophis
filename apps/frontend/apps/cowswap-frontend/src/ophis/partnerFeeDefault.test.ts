import { OPHIS_PARTNER_FEE_RECIPIENT, OPHIS_DEFAULT_APP_DATA_PARTNER_FEE, OPHIS_DEFAULT_PARTNER_FEE } from './partnerFeeDefault'

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
})
