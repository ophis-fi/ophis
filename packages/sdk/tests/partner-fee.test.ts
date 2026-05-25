import { describe, it, expect } from 'vitest';
import {
  ophisDefaultPartnerFee,
  OPHIS_PARTNER_FEE_RECIPIENT,
  OPHIS_PRICE_IMPROVEMENT_BPS,
  OPHIS_MAX_VOLUME_BPS,
  OPHIS_FEE_CHAIN_IDS,
} from '@ophis/sdk';

/**
 * Cross-file drift guard (Phase 3 audit H1, Codex pre-PR MED-1).
 * See apps/frontend/libs/common-const/src/feeRecipient.test.ts for full
 * rationale. If this canonical address changes, update all 3 sites:
 *   - packages/sdk/tests/partner-fee.test.ts (this file)
 *   - apps/frontend/libs/common-const/src/feeRecipient.test.ts
 *   - apps/frontend/apps/cowswap-frontend/src/ophis/partnerFeeDefault.test.ts
 */
const CANONICAL_OPHIS_PARTNER_FEE_RECIPIENT = '0x858f0F5eE954846D47155F5203c04aF1819eCeF8';

describe('@ophis/sdk partner fee defaults', () => {
  it('OPHIS_PARTNER_FEE_RECIPIENT equals the canonical literal (cross-file drift guard)', () => {
    expect(OPHIS_PARTNER_FEE_RECIPIENT).toBe(CANONICAL_OPHIS_PARTNER_FEE_RECIPIENT);
  });

  it('returns the CIP-75 price-improvement fee on Ophis-operated chains', () => {
    for (const chainId of [10, 4326, 999]) {
      const fee = ophisDefaultPartnerFee(chainId);
      expect(fee?.priceImprovementBps).toBe(2500);
      expect(fee?.maxVolumeBps).toBe(50);
      expect(fee?.recipient).toBe(OPHIS_PARTNER_FEE_RECIPIENT);
    }
  });

  it('returns undefined on CoW-hosted chains where Ophis does not operate', () => {
    for (const chainId of [1, 100, 8453, 42161, 137, 43114, 56, 59144, 9745, 57073]) {
      expect(ophisDefaultPartnerFee(chainId)).toBeUndefined();
    }
  });

  it('exposes CIP-75 fee constants matching the live config + backend caps', () => {
    expect(OPHIS_PRICE_IMPROVEMENT_BPS).toBe(2500);
    expect(OPHIS_MAX_VOLUME_BPS).toBe(50);
  });

  it('OPHIS_FEE_CHAIN_IDS is exactly the Ophis-operated set {10, 4326, 999}', () => {
    expect([...OPHIS_FEE_CHAIN_IDS].sort((a, b) => a - b)).toEqual([10, 999, 4326]);
  });

  it('returns a recipient that is a 0x-prefixed 40-hex-char address', () => {
    expect(OPHIS_PARTNER_FEE_RECIPIENT).toMatch(/^0x[a-fA-F0-9]{40}$/);
  });

  it('returns undefined for an unsupported chainId', () => {
    expect(ophisDefaultPartnerFee(999_999)).toBeUndefined();
  });
});
