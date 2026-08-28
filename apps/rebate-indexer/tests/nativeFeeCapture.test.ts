import { describe, it, expect } from 'vitest';
import { decodeFunctionData, parseAbi } from 'viem';
import {
  buildNativeWrapCall,
  buildNativeWrapForChain,
  nativeWrapTargets,
  shouldQueueWrap,
  canBootstrapPropose,
  buildVaultRelayerApprovalCalls,
} from '../src/batch/convert.js';
import {
  WETH_BY_CHAIN,
  WRAPPED_NATIVE_BY_CHAIN,
  NATIVE_SYMBOL_BY_CHAIN,
} from '../src/safe/addresses.js';
import { formatStrandedDetail } from '../src/safe/balances.js';

const WXDAI = '0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d' as const;
const DEPOSIT_ABI = parseAbi(['function deposit()']);

/**
 * Regression cover for the 2026-08-27 fee audit: every xDAI CoW has ever paid us
 * (6.34 xDAI, 100% of realized Gnosis revenue) arrived as the NATIVE coin. The
 * WETH-only pool read could not see it, and the #360 stranded probe skips
 * `tokenAddress === null`, so the alarm built for exactly this could not fire.
 */
describe('buildNativeWrapCall (native fee capture)', () => {
  it('queues nothing when the native balance is below the wrap floor', () => {
    expect(buildNativeWrapCall(999n, 1000n, WXDAI)).toEqual([]);
  });

  it('queues nothing for a zero native balance', () => {
    expect(buildNativeWrapCall(0n, 1000n, WXDAI)).toEqual([]);
  });

  it('wraps at the floor exactly (>=, not >)', () => {
    expect(buildNativeWrapCall(1000n, 1000n, WXDAI)).toHaveLength(1);
  });

  it('wraps the FULL native balance as call value, targeting the wrapped-native token', () => {
    const calls = buildNativeWrapCall(6_342_366_832_375_771_146n, 1000n, WXDAI);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.to.toLowerCase()).toBe(WXDAI.toLowerCase());
    expect(calls[0]!.value).toBe(6_342_366_832_375_771_146n);
  });

  it('carries the amount as msg.value, not as calldata — deposit() takes no args', () => {
    const calls = buildNativeWrapCall(5_000n, 1000n, WXDAI);
    const { functionName, args } = decodeFunctionData({ abi: DEPOSIT_ABI, data: calls[0]!.data });
    expect(functionName).toBe('deposit');
    expect(args ?? []).toHaveLength(0);
  });
});

describe('WRAPPED_NATIVE_BY_CHAIN (the WETH-is-not-WXDAI trap)', () => {
  it('maps Gnosis to WXDAI', () => {
    expect(WRAPPED_NATIVE_BY_CHAIN[100]?.toLowerCase()).toBe(WXDAI.toLowerCase());
  });

  it('is NOT the pool token: on Gnosis the pool reads BRIDGED WETH, wrapping xDAI yields WXDAI', () => {
    // Wrapping xDAI and expecting the WETH-denominated pool to see it is the
    // obvious wrong fix. These MUST differ, which is why the wrapped balance
    // still has to go through the #360 WXDAI -> WETH conversion.
    expect(WRAPPED_NATIVE_BY_CHAIN[100]!.toLowerCase()).not.toBe(WETH_BY_CHAIN[100]!.toLowerCase());
  });

  it('names the native coin for operator-readable alerts', () => {
    expect(NATIVE_SYMBOL_BY_CHAIN[100]).toBe('xDAI');
  });
});

describe('formatStrandedDetail (the alarm must see native)', () => {
  const tok = (symbol: string, balance: string) => ({
    tokenAddress: '0xdddd000000000000000000000000000000000004',
    symbol,
    balance,
  });

  it('reports a native-only Safe — the exact live Gnosis condition', () => {
    // Before this change the probe returned [] here and the batcher stayed silent
    // while the Safe held every xDAI CoW had ever paid.
    const detail = formatStrandedDetail([], 6_342_366_832_375_771_146n, 'xDAI', 5);
    expect(detail).toContain('xDAI');
    expect(detail).toContain('6342366832375771146');
  });

  it('reports native ALONGSIDE stranded ERC-20s', () => {
    const detail = formatStrandedDetail([tok('GNO', '3000')], 500n, 'xDAI', 5);
    expect(detail).toContain('GNO');
    expect(detail).toContain('xDAI');
  });

  it('omits native when there is none, leaving the ERC-20 report unchanged', () => {
    const detail = formatStrandedDetail([tok('GNO', '3000')], 0n, 'xDAI', 5);
    expect(detail).toContain('GNO');
    expect(detail).not.toContain('xDAI');
  });

  it('is empty when the Safe holds neither, so the caller stays silent', () => {
    expect(formatStrandedDetail([], 0n, 'xDAI', 5)).toBe('');
  });

  it('caps the listed ERC-20s but never drops the native line', () => {
    const many = Array.from({ length: 9 }, (_, i) => tok(`T${i}`, '1'));
    const detail = formatStrandedDetail(many, 500n, 'xDAI', 5);
    expect(detail).toContain('+4 more');
    expect(detail).toContain('xDAI');
  });

  it('escapes attacker-controlled token metadata (alerts send as HTML)', () => {
    const detail = formatStrandedDetail([tok('<b>PWN</b>', '1')], 0n, 'xDAI', 5);
    expect(detail).not.toContain('<b>');
    expect(detail).toContain('&lt;b&gt;');
  });
});

describe('buildNativeWrapForChain (per-chain floors)', () => {
  it('wraps a Gnosis balance worth wrapping', () => {
    // The live condition: 6.34 xDAI the pool could never see.
    const calls = buildNativeWrapForChain(100, 6_342_366_832_375_771_146n);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.to.toLowerCase()).toBe(WXDAI.toLowerCase());
  });

  it('leaves Gnosis dust alone rather than burning an owner signature on it', () => {
    expect(buildNativeWrapForChain(100, 1_000_000n)).toEqual([]);
  });

  it('uses a much lower floor on OP-stack chains, where native is ETH not xDAI', () => {
    // 1 xDAI ~ $1 but 1 ETH ~ $2.5k, so a shared wei floor would be absurd on one end.
    expect(buildNativeWrapForChain(10, 4_000_000_000_000_000n)).toHaveLength(1);
    expect(buildNativeWrapForChain(10, 1_000_000_000_000_000n)).toEqual([]);
  });

  it('wraps to the OP-stack WETH predeploy, which IS the pool token there', () => {
    const calls = buildNativeWrapForChain(130, 4_000_000_000_000_000n);
    expect(calls[0]!.to.toLowerCase()).toBe(WETH_BY_CHAIN[130]!.toLowerCase());
  });

  it('returns [] for a chain with no configured wrapper instead of throwing', () => {
    // The batcher runs per-chain; an unconfigured chain must degrade to "do nothing",
    // never take down the payout path.
    expect(buildNativeWrapForChain(999, 10n ** 20n)).toEqual([]);
  });
});

describe('nativeWrapTargets (pending-wrap idempotency)', () => {
  it('extracts the wrapper address from a deposit() inner call', () => {
    expect(nativeWrapTargets(buildNativeWrapCall(5n, 1n, WXDAI))).toEqual([WXDAI.toLowerCase()]);
  });

  it('ignores non-wrap inner calls', () => {
    const approve = buildVaultRelayerApprovalCalls(0n, 1000n, '0xdddd000000000000000000000000000000000004');
    expect(nativeWrapTargets(approve)).toEqual([]);
  });

  it('reports a target once even when it appears twice', () => {
    const twice = [...buildNativeWrapCall(5n, 1n, WXDAI), ...buildNativeWrapCall(7n, 1n, WXDAI)];
    expect(nativeWrapTargets(twice)).toEqual([WXDAI.toLowerCase()]);
  });

  it('survives undecodable calldata without throwing', () => {
    expect(nativeWrapTargets([{ to: WXDAI, value: 0n, data: '0xdeadbeef' }])).toEqual([]);
  });
});

const queue = (o: Partial<{ ok: boolean; count: number; wraps: string[] }> = {}) => ({
  ok: o.ok ?? true,
  count: o.count ?? 0,
  approvals: new Set<string>(),
  wraps: new Set<string>(o.wraps ?? []),
});

describe('shouldQueueWrap (fails closed on an unreadable queue)', () => {
  const calls = buildNativeWrapCall(5n, 1n, WXDAI);

  it('queues when the queue is readable and holds no wrap', () => {
    expect(shouldQueueWrap(calls, queue())).toBe(true);
  });

  it('does not queue when a wrap for the same wrapper is already pending', () => {
    expect(shouldQueueWrap(calls, queue({ wraps: [WXDAI.toLowerCase()] }))).toBe(false);
  });

  it('does NOT queue when the queue could not be read', () => {
    // The failure that matters: an unreadable queue previously looked identical to
    // an empty one, so a second wrap of the SAME full native balance went out and
    // reverted the entire multisend once the first executed.
    expect(shouldQueueWrap(calls, queue({ ok: false }))).toBe(false);
  });

  it('queues nothing when there is no wrap to begin with', () => {
    expect(shouldQueueWrap([], queue())).toBe(false);
  });
});

describe('canBootstrapPropose (breaks the zero-pool deadlock, safely)', () => {
  it('allows a bootstrap when the queue is readable and empty', () => {
    // Without this the Gnosis case never converts: pool 0 -> no payout -> no
    // conversion -> pool 0, which is why no rebate has ever paid.
    expect(canBootstrapPropose(queue({ count: 0 }))).toBe(true);
  });

  it('refuses when anything is already queued, so nothing can be blocked behind it', () => {
    expect(canBootstrapPropose(queue({ count: 1 }))).toBe(false);
  });

  it('refuses when the queue could not be read', () => {
    expect(canBootstrapPropose(queue({ ok: false, count: 0 }))).toBe(false);
  });
});

describe('nativeWrapTargets on a DIRECT (non-MultiSend) pending tx', () => {
  it('detects a hand-queued deposit() that is not wrapped in a MultiSend', () => {
    // An owner can queue WXDAI.deposit() directly from the Safe UI. Decoding that
    // as multiSend(bytes) yields no inner calls, so the wrapper would be absent
    // from the pending set and we would stack a second full-balance wrap behind it.
    const direct = { to: WXDAI, value: 6_000n, data: buildNativeWrapCall(1n, 1n, WXDAI)[0]!.data };
    expect(nativeWrapTargets([direct])).toEqual([WXDAI.toLowerCase()]);
  });
});
