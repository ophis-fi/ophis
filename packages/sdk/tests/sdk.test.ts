import { describe, it, expect } from 'vitest';
import { gregDefaults, GREG_PARTNER_FEE_BPS, GREG_PARTNER_RECIPIENT } from '@greg/sdk';

describe('@greg/sdk defaults', () => {
  it('targets Gnosis Chain (chainId 100)', () => {
    expect(gregDefaults.chainId).toBe(100);
  });

  it('exposes a partner-fee config matching the spec default of 5 bps', () => {
    expect(GREG_PARTNER_FEE_BPS).toBe(5);
  });

  it('has a placeholder partner-fee recipient that callers must override', () => {
    expect(GREG_PARTNER_RECIPIENT).toMatch(/^0x0{40}$/);
  });
});
