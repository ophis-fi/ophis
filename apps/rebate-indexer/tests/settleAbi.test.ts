import { describe, it, expect } from 'vitest';
import { settlementAddressFor, GPV2_SETTLEMENT } from '../src/cow/settleAbi.js';

// The decoder scans the chain's ACTUAL GPv2Settlement. OP (10) and Unichain (130)
// are sovereign Ophis deployments with NON-canonical settlement contracts, so a
// hardcoded canonical address would scan the wrong contract (and find zero Ophis
// trades) on those chains.
describe('settlementAddressFor', () => {
  it('returns the sovereign Optimism GPv2Settlement for chain 10', () => {
    expect(settlementAddressFor(10).toLowerCase()).toBe(
      '0x310784c7fce12d578da6f53460777bac9718b859',
    );
  });

  it('returns the sovereign Unichain GPv2Settlement for chain 130', () => {
    expect(settlementAddressFor(130).toLowerCase()).toBe(
      '0x108a678716e5e1776036ef044cab7064226f714e',
    );
  });

  it('falls back to the canonical GPv2Settlement for hosted chains', () => {
    expect(settlementAddressFor(1)).toBe(GPV2_SETTLEMENT); // Ethereum
    expect(settlementAddressFor(8453)).toBe(GPV2_SETTLEMENT); // Base
    expect(settlementAddressFor(100)).toBe(GPV2_SETTLEMENT); // Gnosis
  });
});
