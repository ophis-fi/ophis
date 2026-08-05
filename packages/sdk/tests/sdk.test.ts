import { describe, it, expect } from 'vitest';
import { ophisDefaults, OPHIS_PARTNER_FEE_RECIPIENT, OPHIS_SOVEREIGN_VOLUME_FEE_BPS } from '@ophis/sdk';

describe('@ophis/sdk defaults', () => {
  it('targets Optimism (chainId 10), the primary Ophis-operated chain', () => {
    expect(ophisDefaults.chainId).toBe(10);
  });

  it('uses the 1 bp sovereign base for its Optimism default', () => {
    expect(ophisDefaults.volumeBps).toBe(1);
    expect(ophisDefaults.volumeBps).toBe(OPHIS_SOVEREIGN_VOLUME_FEE_BPS);
  });

  it('uses the real Ophis partner-fee recipient Safe (not a zero placeholder)', () => {
    expect(ophisDefaults.partnerRecipient).toBe(OPHIS_PARTNER_FEE_RECIPIENT);
    expect(ophisDefaults.partnerRecipient).toMatch(/^0x[a-fA-F0-9]{40}$/);
    expect(ophisDefaults.partnerRecipient).not.toMatch(/^0x0{40}$/);
  });
});
