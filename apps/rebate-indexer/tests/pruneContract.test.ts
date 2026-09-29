import { describe, expect, it, vi } from 'vitest';
import type { PublicClient } from 'viem';
import { hasContractWalletCode } from '../src/fetcher.js';

const owner = `0x${'12'.repeat(20)}` as const;
const rpc = (code: unknown, chainId = 1) => ({
  getChainId: vi.fn().mockResolvedValue(chainId), request: vi.fn().mockResolvedValue(code),
});

describe('prune contract-wallet verification', () => {
  it.each([['0x', false], ['0x6000', true]] as const)('checks explicit bytecode %s', async (code, expected) => {
    const client = rpc(code);
    expect(await hasContractWalletCode(1, owner, new AbortController().signal, client as unknown as PublicClient)).toBe(expected);
    expect(client.request).toHaveBeenCalledWith({ method: 'eth_getCode', params: [owner, 'latest'] });
  });

  it.each([null, undefined, '0x0', ''])('does not treat malformed bytecode %s as an empty EOA', async (code) => {
    await expect(hasContractWalletCode(1, owner, new AbortController().signal, rpc(code) as unknown as PublicClient)).rejects.toThrow();
  });

  it('rejects a mismatched RPC chain before reading code', async () => {
    const client = rpc('0x', 100);
    await expect(hasContractWalletCode(1, owner, new AbortController().signal, client as unknown as PublicClient)).rejects.toThrow(/chain mismatch/);
    expect(client.request).not.toHaveBeenCalled();
  });

  it('stops waiting when the prune budget expires during an RPC read', async () => {
    const controller = new AbortController();
    const client = rpc('0x');
    client.request.mockImplementation(() => new Promise(() => {}));
    const pending = hasContractWalletCode(1, owner, controller.signal, client as unknown as PublicClient);
    await Promise.resolve();
    controller.abort(new Error('prune deadline'));
    await expect(pending).rejects.toThrow('prune deadline');
  });
});
