import { describe, it, expect } from 'vitest';
import { gnosisFallbackTransport, GNOSIS_RPC_URLS } from '@ophis/rpc';

describe('@ophis/rpc gnosisFallbackTransport', () => {
  it('exports the URL list with Alchemy first, then PublicNode, then Ankr', () => {
    expect(GNOSIS_RPC_URLS).toHaveLength(3);
    expect(GNOSIS_RPC_URLS[0]).toMatch(/alchemy/i);
    expect(GNOSIS_RPC_URLS[1]).toMatch(/publicnode/i);
    expect(GNOSIS_RPC_URLS[2]).toMatch(/ankr/i);
  });

  it('returns a viem transport function', () => {
    const tx = gnosisFallbackTransport();
    expect(typeof tx).toBe('function');
  });
});
