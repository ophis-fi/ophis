import { describe, it, expect } from 'vitest';
import {
  ophisDefaultPartnerFee,
  OPHIS_PARTNER_FEE_RECIPIENT,
  OPHIS_PARTNER_FEE_BPS,
} from '@ophis/sdk';

/**
 * Cross-file drift guard (Phase 3 audit H1, Codex pre-PR MED-1).
 * See apps/frontend/libs/common-const/src/feeRecipient.test.ts for full
 * rationale. If this canonical address changes, update all 3 sites:
 *   - packages/sdk/tests/partner-fee.test.ts (this file)
 *   - apps/frontend/libs/common-const/src/feeRecipient.test.ts
 *   - apps/frontend/apps/cowswap-frontend/src/ophis/partnerFeeDefault.test.ts
 *     (added in the same PR)
 */
const CANONICAL_OPHIS_PARTNER_FEE_RECIPIENT = '0x858f0F5eE954846D47155F5203c04aF1819eCeF8';

describe('@ophis/sdk partner fee defaults', () => {
  it('OPHIS_PARTNER_FEE_RECIPIENT equals the canonical literal (cross-file drift guard)', () => {
    expect(OPHIS_PARTNER_FEE_RECIPIENT).toBe(CANONICAL_OPHIS_PARTNER_FEE_RECIPIENT);
  });

  it('returns the same recipient on every CoW-supported chainId', () => {
    const chains = [1, 100, 8453, 42161, 137, 43114, 56, 59144, 9745, 57073];
    for (const chainId of chains) {
      const fee = ophisDefaultPartnerFee(chainId);
      expect(fee?.bps).toBe(5);
      expect(fee?.recipient).toBe(OPHIS_PARTNER_FEE_RECIPIENT);
    }
  });

  it('exposes the bps constant matching the spec default', () => {
    expect(OPHIS_PARTNER_FEE_BPS).toBe(5);
  });

  it('returns a recipient that is a 0x-prefixed 40-hex-char address', () => {
    expect(OPHIS_PARTNER_FEE_RECIPIENT).toMatch(/^0x[a-fA-F0-9]{40}$/);
  });

  it('returns undefined for an unsupported chainId', () => {
    expect(ophisDefaultPartnerFee(999_999)).toBeUndefined();
  });
});
