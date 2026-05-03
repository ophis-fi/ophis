import { describe, it, expect } from 'vitest';
import {
  gregDefaultPartnerFee,
  GREG_PARTNER_FEE_RECIPIENT,
  GREG_PARTNER_FEE_BPS,
} from '@greg/sdk';

describe('@greg/sdk partner fee defaults', () => {
  it('returns the same recipient on every CoW-supported chainId', () => {
    const chains = [1, 100, 8453, 42161, 137, 43114, 56, 59144, 9745, 57073];
    for (const chainId of chains) {
      const fee = gregDefaultPartnerFee(chainId);
      expect(fee?.bps).toBe(5);
      expect(fee?.recipient).toBe(GREG_PARTNER_FEE_RECIPIENT);
    }
  });

  it('exposes the bps constant matching the spec default', () => {
    expect(GREG_PARTNER_FEE_BPS).toBe(5);
  });

  it('returns a recipient that is a 0x-prefixed 40-hex-char address', () => {
    expect(GREG_PARTNER_FEE_RECIPIENT).toMatch(/^0x[a-fA-F0-9]{40}$/);
  });

  it('returns undefined for an unsupported chainId', () => {
    expect(gregDefaultPartnerFee(999_999)).toBeUndefined();
  });
});
