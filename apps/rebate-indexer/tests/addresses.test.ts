import { describe, it, expect } from 'vitest';
import {
  OPHIS_SAFE_ADDRESS,
  WETH_GNOSIS,
  multiSendCallOnlyAddress,
  WETH_BY_CHAIN,
} from '../src/safe/addresses.js';

describe('canonical addresses', () => {
  it('OPHIS_SAFE_ADDRESS matches packages/sdk/src/partner-fee.ts', () => {
    expect(OPHIS_SAFE_ADDRESS).toBe('0x858f0F5eE954846D47155F5203c04aF1819eCeF8');
  });

  it('WETH_GNOSIS is the canonical Gnosis WETH (bridged Ethereum WETH)', () => {
    // Source: https://docs.cow.fi/cow-protocol/reference/contracts/core
    // verify on https://gnosisscan.io/token/0x6a023ccd1ff6f2045c3309768ead9e68f978f6e1
    expect(WETH_GNOSIS).toBe('0x6A023CCd1ff6F2045C3309768eAd9E68F978f6e1');
  });

  it('multiSendCallOnlyAddress resolves a 1.4.1 deployment for Gnosis Chain (100)', () => {
    const addr = multiSendCallOnlyAddress(100);
    expect(addr).toMatch(/^0x[a-fA-F0-9]{40}$/);
  });

  it('multiSendCallOnlyAddress throws for an unsupported chain', () => {
    expect(() => multiSendCallOnlyAddress(999_999)).toThrow();
  });

  it('WETH_BY_CHAIN includes Gnosis at minimum (Phase 1 single-chain target)', () => {
    expect(WETH_BY_CHAIN[100]).toBe(WETH_GNOSIS);
  });
});
