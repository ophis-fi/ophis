import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { getRpcClient, _resetRpcClients } from '../src/rpc/client.js';

// The settle decoder resolves its read client via getRpcClient(chainId). For the
// sovereign chains (OP 10, Unichain 130) it must resolve WITHOUT any env set, or the
// decoder throws "no RPC configured" on every run and never indexes those chains.
const ENV = ['SETTLE_RPC_URL_10', 'SETTLE_RPC_FALLBACK_10', 'SETTLE_RPC_URL_130', 'SETTLE_RPC_FALLBACK_130', 'DRPC_API_KEY'];
let saved: Record<string, string | undefined>;
beforeEach(() => { saved = {}; for (const k of ENV) { saved[k] = process.env[k]; delete process.env[k]; } _resetRpcClients(); });
afterEach(() => { for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } _resetRpcClients(); });

describe('getRpcClient sovereign defaults', () => {
  it('resolves a client for Optimism (10) with no env configured', () => {
    expect(() => getRpcClient(10)).not.toThrow();
  });
  it('resolves a client for Unichain (130) with no env configured', () => {
    expect(() => getRpcClient(130)).not.toThrow();
  });
});
