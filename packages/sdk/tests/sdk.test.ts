import { describe, it, expect } from 'vitest';
import { ophisDefaults, OPHIS_PARTNER_FEE_BPS, OPHIS_PARTNER_RECIPIENT } from '@ophis/sdk';

describe('@ophis/sdk defaults', () => {
  it('targets Gnosis Chain (chainId 100)', () => {
    expect(ophisDefaults.chainId).toBe(100);
  });

  it('exposes a partner-fee config matching the spec default of 5 bps', () => {
    expect(OPHIS_PARTNER_FEE_BPS).toBe(5);
  });

  it('has a placeholder partner-fee recipient that callers must override', () => {
    expect(OPHIS_PARTNER_RECIPIENT).toMatch(/^0x0{40}$/);
  });
});
