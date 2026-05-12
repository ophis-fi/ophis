import { describe, it, expect } from 'vitest';
import {
  ophisDefaultPartnerFee,
  OPHIS_PARTNER_FEE_RECIPIENT,
  OPHIS_PARTNER_FEE_BPS,
} from '@ophis/sdk';

describe('@ophis/sdk partner fee defaults', () => {
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
