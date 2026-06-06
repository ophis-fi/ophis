import { describe, it, expect } from 'vitest';
import { decodeFunctionData, encodeFunctionData, parseAbi } from 'viem';
import {
  applySlippageFloor,
  buildVaultRelayerApprovalCalls,
  vaultRelayerApprovalTokens,
} from '../src/batch/convert.js';
import { GPV2_VAULT_RELAYER } from '../src/safe/addresses.js';
import { encodeMultiSend, encodeMultiSendCalldata, decodeMultiSendCalldata, type InnerCall } from '../src/batch/multisend.js';

const APPROVE_ABI = parseAbi(['function approve(address spender, uint256 amount)']);
const decodeApprove = (call: InnerCall): readonly [string, bigint] => {
  const { args } = decodeFunctionData({ abi: APPROVE_ABI, data: call.data });
  return [(args[0] as string).toLowerCase(), args[1] as bigint];
};
const VR = GPV2_VAULT_RELAYER.toLowerCase();
const TOKEN = '0xdddd000000000000000000000000000000000004' as const;

describe('applySlippageFloor (#360 fee conversion)', () => {
  it('floors a quoted buyAmount by the given bps', () => {
    expect(applySlippageFloor(10_000n, 200)).toBe(9_800n); // 2%
    expect(applySlippageFloor(1_000_000_000_000_000_000n, 100)).toBe(990_000_000_000_000_000n); // 1% of 1e18
  });

  it('0 bps is identity (no floor)', () => {
    expect(applySlippageFloor(12_345n, 0)).toBe(12_345n);
  });

  it('uses integer (floor) division — never rounds the min-buy up', () => {
    // 101 * 9800 / 10000 = 98.98 -> 98 (a higher min-buy would over-constrain the fill)
    expect(applySlippageFloor(101n, 200)).toBe(98n);
  });

  it('handles 0 buyAmount', () => {
    expect(applySlippageFloor(0n, 200)).toBe(0n);
  });

  it('rejects out-of-range bps (fail-loud, no silent 0% or negative floor)', () => {
    expect(() => applySlippageFloor(1n, -1)).toThrow();
    expect(() => applySlippageFloor(1n, 10_000)).toThrow();
    expect(() => applySlippageFloor(1n, 20_000)).toThrow();
  });
});

describe('buildVaultRelayerApprovalCalls (#360 USDT-style approve reset)', () => {
  it('returns NO approval when the allowance already covers the sell amount', () => {
    expect(buildVaultRelayerApprovalCalls(1000n, 1000n, TOKEN)).toEqual([]); // exactly equal: no approve needed
    expect(buildVaultRelayerApprovalCalls(2000n, 1000n, TOKEN)).toEqual([]); // more than enough
  });

  it('a SINGLE approve(N) when the current allowance is zero', () => {
    const calls = buildVaultRelayerApprovalCalls(0n, 1000n, TOKEN);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.to.toLowerCase()).toBe(TOKEN);
    expect(decodeApprove(calls[0]!)).toEqual([VR, 1000n]);
  });

  it('resets to zero FIRST — approve(0) then approve(N) — for a non-zero partial allowance (USDT-style)', () => {
    const calls = buildVaultRelayerApprovalCalls(400n, 1000n, TOKEN);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.to.toLowerCase()).toBe(TOKEN);
    expect(calls[1]!.to.toLowerCase()).toBe(TOKEN);
    expect(decodeApprove(calls[0]!)).toEqual([VR, 0n]); // reset
    expect(decodeApprove(calls[1]!)).toEqual([VR, 1000n]); // re-approve full
  });
});

describe('vaultRelayerApprovalTokens (#360 pending-approval idempotency)', () => {
  it('extracts the token of an approve(VaultRelayer, _) inner call', () => {
    const calls = buildVaultRelayerApprovalCalls(0n, 1000n, TOKEN);
    expect(vaultRelayerApprovalTokens(calls)).toEqual([TOKEN]);
  });

  it('reports the token ONCE even for a two-call USDT reset (approve(0)+approve(N))', () => {
    const calls = buildVaultRelayerApprovalCalls(400n, 1000n, TOKEN);
    expect(vaultRelayerApprovalTokens(calls)).toEqual([TOKEN]);
  });

  it('ignores approvals to a DIFFERENT spender', () => {
    const calls: InnerCall[] = [
      {
        to: TOKEN,
        value: 0n,
        data: encodeFunctionData({
          abi: APPROVE_ABI,
          functionName: 'approve',
          args: ['0x1111111111111111111111111111111111111111', 1n],
        }),
      },
    ];
    expect(vaultRelayerApprovalTokens(calls)).toEqual([]);
  });

  it('ignores non-approve inner calls (e.g. a WETH transfer)', () => {
    const transferAbi = parseAbi(['function transfer(address to, uint256 amount)']);
    const calls: InnerCall[] = [
      {
        to: '0xeeee000000000000000000000000000000000005',
        value: 0n,
        data: encodeFunctionData({
          abi: transferAbi,
          functionName: 'transfer',
          args: ['0x2222222222222222222222222222222222222222', 5n],
        }),
      },
    ];
    expect(vaultRelayerApprovalTokens(calls)).toEqual([]);
  });

  it('composes with decodeMultiSendCalldata: finds the approval token inside a packed multisend', () => {
    const calls = buildVaultRelayerApprovalCalls(0n, 777n, TOKEN);
    const outer = encodeMultiSendCalldata(encodeMultiSend(calls));
    expect(vaultRelayerApprovalTokens(decodeMultiSendCalldata(outer))).toEqual([TOKEN]);
  });
});
