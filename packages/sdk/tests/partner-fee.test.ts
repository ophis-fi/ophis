import { describe, it, expect } from 'vitest';
import {
  ophisDefaultPartnerFee,
  buildOphisAppDataPartnerFee,
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

  it('returns the CIP-75 fee on all CoW-supported chains (restored all-chain model 2026-05-27)', () => {
    for (const chainId of [1, 100, 8453, 42161, 137, 43114, 56, 59144, 9745, 57073]) {
      const fee = ophisDefaultPartnerFee(chainId);
      expect(fee?.priceImprovementBps).toBe(2500);
      expect(fee?.recipient).toBe(OPHIS_PARTNER_FEE_RECIPIENT);
    }
  });

  it('exposes CIP-75 fee constants matching the live config + backend caps', () => {
    expect(OPHIS_PRICE_IMPROVEMENT_BPS).toBe(2500);
    expect(OPHIS_MAX_VOLUME_BPS).toBe(50);
  });

  it('OPHIS_FEE_CHAIN_IDS covers all served chains (operated + CoW-hosted)', () => {
    expect([...OPHIS_FEE_CHAIN_IDS].sort((a, b) => a - b)).toEqual([
      1, 10, 56, 100, 137, 999, 4326, 8453, 9745, 42161, 43114, 57073, 59144,
    ]);
  });

  it('returns a recipient that is a 0x-prefixed 40-hex-char address', () => {
    expect(OPHIS_PARTNER_FEE_RECIPIENT).toMatch(/^0x[a-fA-F0-9]{40}$/);
  });

  it('returns undefined for an unsupported chainId', () => {
    expect(ophisDefaultPartnerFee(999_999)).toBeUndefined();
  });

  it('throws on an invalid chainId so a forgotten arg fails loud (not a silent undefined)', () => {
    // @ts-expect-error testing the runtime guard with a missing arg
    expect(() => ophisDefaultPartnerFee()).toThrow(/positive integer/);
    expect(() => ophisDefaultPartnerFee(Number.NaN)).toThrow(/positive integer/);
    expect(() => ophisDefaultPartnerFee(0)).toThrow(/positive integer/);
    expect(() => ophisDefaultPartnerFee(-10)).toThrow(/positive integer/);
  });

  it('buildOphisAppDataPartnerFee returns the exact appData.metadata.partnerFee fragment', () => {
    expect(buildOphisAppDataPartnerFee(10)).toEqual({
      priceImprovementBps: 2500,
      maxVolumeBps: 50,
      recipient: OPHIS_PARTNER_FEE_RECIPIENT,
    });
    expect(buildOphisAppDataPartnerFee(1)).toEqual({
      priceImprovementBps: 2500,
      maxVolumeBps: 50,
      recipient: OPHIS_PARTNER_FEE_RECIPIENT,
    });
  });
});
