import { describe, it, expect } from 'vitest';
import { SCAN_CHAINS, resolveRpcUrl, selectChains } from '../../src/scan/chains.js';

describe('chains', () => {
  it('includes OP as local-db and mainnet as rpc', () => {
    const op = SCAN_CHAINS.find((c) => c.chainId === 10)!;
    const eth = SCAN_CHAINS.find((c) => c.chainId === 1)!;
    expect(op.kind).toBe('local-db');
    expect(op.dbContainer).toBe('optimism-mainnet-db-1');
    expect(eth.kind).toBe('rpc');
    expect(eth.alchemySubdomain).toBe('eth-mainnet');
  });
  it('builds an Alchemy URL without leaking the key into the host', () => {
    const eth = SCAN_CHAINS.find((c) => c.chainId === 1)!;
    expect(resolveRpcUrl(eth, 'SECRETKEY')).toBe('https://eth-mainnet.g.alchemy.com/v2/SECRETKEY');
  });
  it('selectChains filters by name, defaults to all', () => {
    expect(selectChains(['ethereum']).map((c) => c.chainId)).toEqual([1]);
    expect(selectChains().length).toBe(SCAN_CHAINS.length);
    expect(() => selectChains(['nope'])).toThrow();
  });
});
