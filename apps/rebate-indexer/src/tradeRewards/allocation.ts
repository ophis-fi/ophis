import { createHash, createHmac } from 'node:crypto';
import { ONE_USDG, TEN_USDG, TRADE_REWARDS_MAX_PAYOUT, TRADE_REWARDS_MAX_TICKETS } from './config.js';

const UINT256_RANGE = 1n << 256n;

function deterministicIndex(seed: Buffer, counter: number, upperExclusive: number): number {
  if (upperExclusive <= 0) throw new Error('allocation upper bound must be positive');
  const bound = BigInt(upperExclusive);
  const unbiasedLimit = UINT256_RANGE - (UINT256_RANGE % bound);
  let attempt = 0;
  while (true) {
    const digest = createHmac('sha256', seed)
      .update(`ophis-rewards-v1:${counter}:${attempt}`)
      .digest();
    const candidate = BigInt(`0x${digest.toString('hex')}`);
    if (candidate < unbiasedLimit) return Number(candidate % bound);
    attempt += 1;
  }
}

export function parseAllocationSeed(raw: string | undefined): Buffer {
  const normalized = raw?.trim().replace(/^0x/, '');
  if (!normalized || !/^[0-9a-fA-F]{64}$/.test(normalized)) {
    throw new Error('trade reward allocation seed must be exactly 32 random bytes encoded as hex');
  }
  return Buffer.from(normalized, 'hex');
}

export function buildRewardAllocation(seed: Buffer): readonly bigint[] {
  if (seed.length !== 32) throw new Error('allocation seed must be 32 bytes');
  const allocation = [
    ...Array.from({ length: 100 }, () => ONE_USDG),
    ...Array.from({ length: 5 }, () => TEN_USDG),
  ];
  for (let i = allocation.length - 1; i > 0; i -= 1) {
    const j = deterministicIndex(seed, allocation.length - 1 - i, i + 1);
    const left = allocation[i];
    const right = allocation[j];
    if (left === undefined || right === undefined) throw new Error('allocation shuffle index out of bounds');
    allocation[i] = right;
    allocation[j] = left;
  }
  const total = allocation.reduce((sum, amount) => sum + amount, 0n);
  if (allocation.length !== TRADE_REWARDS_MAX_TICKETS || total !== TRADE_REWARDS_MAX_PAYOUT) {
    throw new Error('reward allocation invariant failed');
  }
  return Object.freeze(allocation);
}

export function allocationCommitment(seed: Buffer, allocation: readonly bigint[]): `0x${string}` {
  const encoded = allocation.map((amount) => amount.toString()).join(',');
  return `0x${createHash('sha256')
    .update('ophis-rewards-v1\0', 'utf8')
    .update(seed)
    .update('\0', 'utf8')
    .update(encoded, 'utf8')
    .digest('hex')}`;
}
