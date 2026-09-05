import { describe, it, expect } from 'vitest';
import {
  SCAN_CHAINS,
  blockRpcEnvName,
  resolveBlockRpcUrl,
  resolveRpcUrl,
  rpcEnvName,
  selectChains,
} from '../../src/scan/chains.js';

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
    expect(eth).toBeDefined();
    expect(resolveRpcUrl(eth, 'SECRETKEY', {})).toBe('https://eth-mainnet.g.alchemy.com/v2/SECRETKEY');
  });
  it('uses an explicit per-chain override before provider and public defaults', () => {
    const eth = SCAN_CHAINS.find((c) => c.chainId === 1)!;
    expect(rpcEnvName(eth)).toBe('SCAN_RPC_ETHEREUM');
    expect(resolveRpcUrl(eth, 'SECRETKEY', { SCAN_RPC_ETHEREUM: 'https://rpc.example' })).toBe('https://rpc.example');
  });
  it('uses a keyless public fallback and throws on a local-db chain', () => {
    const op = SCAN_CHAINS.find((c) => c.chainId === 10)!;
    const eth = SCAN_CHAINS.find((c) => c.chainId === 1)!;
    expect(() => resolveRpcUrl(op, 'KEY')).toThrow();
    expect(resolveRpcUrl(eth, '', {})).toBe('https://eth.drpc.org');
  });
  it('can split historical block reads from log reads while respecting overrides', () => {
    const bnb = SCAN_CHAINS.find((c) => c.chainId === 56)!;
    expect(blockRpcEnvName(bnb)).toBe('SCAN_BLOCK_RPC_BNB');
    expect(resolveRpcUrl(bnb, '', {})).toBe('https://bsc.drpc.org');
    expect(resolveBlockRpcUrl(bnb, '', {})).toBe('https://bsc-dataseed.binance.org');
    expect(resolveBlockRpcUrl(bnb, '', { SCAN_RPC_BNB: 'https://all.example' })).toBe('https://all.example');
    expect(resolveBlockRpcUrl(bnb, '', {
      SCAN_RPC_BNB: 'https://logs.example',
      SCAN_BLOCK_RPC_BNB: 'https://blocks.example',
    })).toBe('https://blocks.example');
  });
  it('covers all 13 production chains', () => {
    expect(SCAN_CHAINS.map((c) => c.chainId).sort((a, b) => a - b)).toEqual([
      1, 10, 56, 100, 130, 137, 4663, 8453, 9745, 42161, 43114, 57073, 59144,
    ]);
  });
  it('selectChains filters by name, defaults to all', () => {
    expect(selectChains(['ethereum']).map((c) => c.chainId)).toEqual([1]);
    expect(selectChains().length).toBe(SCAN_CHAINS.length);
    expect(() => selectChains(['nope'])).toThrow();
  });
});
