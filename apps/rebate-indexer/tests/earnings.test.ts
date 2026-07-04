import { describe, it, expect } from 'vitest';
import { assembleEarnings, type EarningsInput } from '../src/earnings.js';

const NOW = new Date('2026-07-04T00:00:00.000Z');

// A stacked-fee integrator with volume on both sovereign chains (OP 10, Unichain 130)
// and one CoW-hosted chain (Base 8453). Fee bases are USD*bps (assembler / 10_000):
//   OP:       100k vol, ophis 10 bps -> $100, own 25 bps -> $250
//   Unichain:  50k vol, ophis 10 bps -> $50,  own 25 bps -> $125
//   Base:     200k vol, ophis 10 bps -> $200, own 30 bps -> $600
const RECIPIENT = ('0x' + 'ab'.repeat(20)) as `0x${string}`;
const fullInput: EarningsInput = {
  byChain: [
    { chainId: 10, volumeUsd: 100_000, trades: 5, ophisFeeBase: 100_000 * 10, ownFeeBase: 100_000 * 25 },
    { chainId: 130, volumeUsd: 50_000, trades: 3, ophisFeeBase: 50_000 * 10, ownFeeBase: 50_000 * 25 },
    { chainId: 8453, volumeUsd: 200_000, trades: 10, ophisFeeBase: 200_000 * 10, ownFeeBase: 200_000 * 30 },
  ],
  ownFeeRecipient: RECIPIENT,
  registered: true,
  payouts: [
    { cycleMonth: '2026-05-01', txHash: ('0x' + 'aa'.repeat(32)) as `0x${string}`, paidWei: '1000000000000000000', wethUsd: 3000 },
    { cycleMonth: '2026-06-01', txHash: ('0x' + 'bb'.repeat(32)) as `0x${string}`, paidWei: '500000000000000000', wethUsd: 3200 },
  ],
};

describe('assembleEarnings - sovereign-vs-hosted scoping', () => {
  it('splits routed volume by sovereign (OP+Unichain) vs hosted, reconciling to the total', () => {
    const e = assembleEarnings('acme-dapp', fullInput, NOW);
    expect(e.routedVolumeUsd.sovereign).toBe(150_000); // 100k OP + 50k Unichain
    expect(e.routedVolumeUsd.hosted).toBe(200_000); // Base
    expect(e.routedVolumeUsd.total).toBe(350_000);
    expect(e.routedVolumeUsd.sovereign + e.routedVolumeUsd.hosted).toBe(e.routedVolumeUsd.total);
    expect(e.sovereignChains).toEqual([10, 130]);
  });

  it('scopes GUARANTEED own-fee to the sovereign chains and labels hosted as CoW-disbursed', () => {
    const e = assembleEarnings('acme-dapp', fullInput, NOW);
    // sovereignGuaranteed = OP $250 + Unichain $125 = $375; hostedAccrued = Base $600.
    expect(e.ownFeeAccruedUsd.sovereignGuaranteed).toBe(375);
    expect(e.ownFeeAccruedUsd.hostedAccrued).toBe(600);
    expect(e.ownFeeAccruedUsd.total).toBe(975);
    // The hosted figure MUST carry the exact not-guaranteed labeling required by the scope constraint.
    expect(e.ownFeeAccruedUsd.note).toContain('paid out by CoW under CoW terms; not guaranteed by Ophis');
    expect(e.ownFeeAccruedUsd.recipient).toBe(RECIPIENT);
  });

  it('reports the Ophis base fee (informational) split the same way', () => {
    const e = assembleEarnings('acme-dapp', fullInput, NOW);
    expect(e.ophisFeeAccruedUsd.sovereign).toBe(150); // $100 + $50
    expect(e.ophisFeeAccruedUsd.hosted).toBe(200);
    expect(e.ophisFeeAccruedUsd.total).toBe(350);
  });

  it('marks each per-chain row sovereign/hosted and computes per-chain own-fee', () => {
    const e = assembleEarnings('acme-dapp', fullInput, NOW);
    const op = e.byChain.find((c) => c.chainId === 10)!;
    const base = e.byChain.find((c) => c.chainId === 8453)!;
    expect(op.sovereign).toBe(true);
    expect(op.chainName).toBe('Optimism');
    expect(op.ownFeeAccruedUsd).toBe(250);
    expect(base.sovereign).toBe(false);
    expect(base.chainName).toBe('Base');
    expect(base.ownFeeAccruedUsd).toBe(600);
  });

  it('carries a top-level disclaimer naming the OP/Unichain vs CoW-hosted scoping', () => {
    const e = assembleEarnings('acme-dapp', fullInput, NOW);
    expect(typeof e.disclaimer).toBe('string');
    expect(e.disclaimer).toContain('Optimism');
    expect(e.disclaimer).toContain('Unichain');
    expect(e.disclaimer).toContain('paid out by CoW under CoW terms; not guaranteed by Ophis');
  });
});

describe('assembleEarnings - referral share (Ophis-paid) and payout links', () => {
  it('sums EXACT paid-to-date from executed batches and builds explorer links', () => {
    const e = assembleEarnings('acme-dapp', fullInput, NOW);
    expect(e.referral.registered).toBe(true);
    expect(e.referral.paidToDateWeth).toBe(1.5); // 1.0 + 0.5
    expect(e.referral.paidToDateUsd).toBe(4600); // 1*3000 + 0.5*3200
    expect(e.referral.payouts).toHaveLength(2);
    const p0 = e.referral.payouts[0]!;
    expect(p0.cycleMonth).toBe('2026-05'); // YYYY-MM, not a full date / not a future timing signal
    expect(p0.chainId).toBe(100); // the Gnosis affiliate payout Safe
    expect(p0.explorerUrl).toBe(`https://gnosisscan.io/tx/${p0.txHash}`);
    expect(p0.amountWeth).toBe(1);
  });

  it('reports an unregistered appCode with no referral accrual and no payouts', () => {
    const e = assembleEarnings('unregistered-code', { ...fullInput, registered: false, payouts: [] }, NOW);
    expect(e.referral.registered).toBe(false);
    expect(e.referral.paidToDateWeth).toBe(0);
    expect(e.referral.paidToDateUsd).toBe(0);
    expect(e.referral.payouts).toEqual([]);
    expect(e.referral.note).toContain('not a registered referral code');
    // Own-fee is independent of registration, so it still reports.
    expect(e.ownFeeAccruedUsd.total).toBe(975);
  });
});

describe('assembleEarnings - security invariant (no front-runner leak)', () => {
  it('never emits a 30d / current-cycle / next-payout signal', () => {
    const e = assembleEarnings('acme-dapp', fullInput, NOW);
    const json = JSON.stringify(e).toLowerCase();
    // The admin-only /status and sig-gated /partner own these; this keyless surface must not.
    for (const forbidden of ['30d', 'volume_30d', 'nextpayout', 'next_batch', 'currentcycle', 'estimated']) {
      expect(json).not.toContain(forbidden);
    }
    // Routed volume is lifetime cumulative, so there is no cycle window field.
    expect(e).not.toHaveProperty('nextPayoutAt');
    expect(e).not.toHaveProperty('currentCycleVolumeUsd');
    expect(e).not.toHaveProperty('estimatedCurrentCycleEarningsUsd');
  });

  it('handles an empty integrator (no indexed trades) as all-zero with the disclaimer intact', () => {
    const e = assembleEarnings('nobody', { byChain: [], ownFeeRecipient: null, registered: false, payouts: [] }, NOW);
    expect(e.routedVolumeUsd.total).toBe(0);
    expect(e.ownFeeAccruedUsd.total).toBe(0);
    expect(e.byChain).toEqual([]);
    expect(e.disclaimer.length).toBeGreaterThan(0);
    expect(e.ownFeeAccruedUsd.recipient).toBeNull();
  });
});
