import { describe, it, expect } from 'vitest';
import { gnosisFallbackTransport, GNOSIS_RPC_URLS } from '@ophis/rpc';

describe('@ophis/rpc gnosisFallbackTransport', () => {
  it('exports a default list of public, no-quota Gnosis RPCs (no Alchemy)', () => {
    expect(GNOSIS_RPC_URLS.length).toBeGreaterThanOrEqual(3);
    expect(GNOSIS_RPC_URLS[0]).toMatch(/publicnode/i);
    // Alchemy must NOT appear unless OPHIS_RPC_USE_ALCHEMY=1 is set.
    // The 2026-05-13 incident: shared Alchemy free tier hit 90% from a
    // single chain stack, threatening to block the entire org's dev.
    // Default behaviour: zero Alchemy traffic.
    for (const u of GNOSIS_RPC_URLS) {
      expect(u).not.toMatch(/alchemy/i);
    }
  });

  it('returns a viem transport function', () => {
    const tx = gnosisFallbackTransport();
    expect(typeof tx).toBe('function');
  });
});
