import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { getRpcClient, _resetRpcClients } from '../src/rpc/client.js';

// The settle decoder resolves its read client via getRpcClient(chainId). For the
// sovereign chains (OP 10, Unichain 130) it must resolve WITHOUT any env set, or the
// decoder throws "no RPC configured" on every run and never indexes those chains.
const ENV = ['SETTLE_RPC_URL_1', 'SETTLE_RPC_FALLBACK_1', 'SETTLE_RPC_URL_10', 'SETTLE_RPC_FALLBACK_10', 'SETTLE_RPC_URL_130', 'SETTLE_RPC_FALLBACK_130', 'DRPC_API_KEY'];
let saved: Record<string, string | undefined>;
beforeEach(() => { saved = {}; for (const k of ENV) { saved[k] = process.env[k]; delete process.env[k]; } _resetRpcClients(); });
afterEach(() => { for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } _resetRpcClients(); vi.unstubAllGlobals(); });

describe('getRpcClient sovereign defaults', () => {
  it('resolves a client for Optimism (10) with no env configured', () => {
    expect(() => getRpcClient(10)).not.toThrow();
  });
  it('resolves a client for Unichain (130) with no env configured', () => {
    expect(() => getRpcClient(130)).not.toThrow();
  });
});

describe('Ethereum primary and fallback', () => {
  it.each([false, true])('uses the configured lane when primary unavailable=%s', async (unavailable) => {
    process.env.SETTLE_RPC_URL_1 = 'http://baal.test:8547/';
    process.env.SETTLE_RPC_FALLBACK_1 = 'https://fallback.test/';
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      calls.push(String(url));
      if (String(url) === process.env.SETTLE_RPC_URL_1 && unavailable) {
        return new Response('unavailable', { status: 503 });
      }
      const request = JSON.parse(String(init.body));
      return Response.json({ jsonrpc: '2.0', id: request.id, result: '0x123' });
    }));

    expect(await getRpcClient(1).getBlockNumber()).toBe(291n);
    expect(calls[0]).toBe(process.env.SETTLE_RPC_URL_1);
    expect(calls.includes(process.env.SETTLE_RPC_FALLBACK_1)).toBe(unavailable);

    // An Ethereum override must never redirect an L2 client to baal.
    calls.length = 0;
    await getRpcClient(10).getBlockNumber();
    expect(calls).toEqual(['https://mainnet.optimism.io/']);
  });
});
