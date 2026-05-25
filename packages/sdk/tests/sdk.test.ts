import { describe, it, expect } from 'vitest';
import { ophisDefaults, OPHIS_PARTNER_FEE_RECIPIENT, OPHIS_PRICE_IMPROVEMENT_BPS } from '@ophis/sdk';

describe('@ophis/sdk defaults', () => {
  it('targets Optimism (chainId 10), the primary Ophis-operated chain', () => {
    expect(ophisDefaults.chainId).toBe(10);
  });

  it('uses the CIP-75 price-improvement fee (25% / 2500 bps), not a flat bps', () => {
    expect(ophisDefaults.priceImprovementBps).toBe(2500);
    expect(ophisDefaults.priceImprovementBps).toBe(OPHIS_PRICE_IMPROVEMENT_BPS);
    expect(ophisDefaults.maxVolumeBps).toBe(50);
  });

  it('uses the real Ophis partner-fee recipient Safe (not a zero placeholder)', () => {
    expect(ophisDefaults.partnerRecipient).toBe(OPHIS_PARTNER_FEE_RECIPIENT);
    expect(ophisDefaults.partnerRecipient).toMatch(/^0x[a-fA-F0-9]{40}$/);
    expect(ophisDefaults.partnerRecipient).not.toMatch(/^0x0{40}$/);
  });
});
