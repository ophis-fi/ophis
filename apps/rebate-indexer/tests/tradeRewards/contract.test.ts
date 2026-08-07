import { describe, expect, it } from 'vitest';
import { assertRewardsFunding } from '../../src/tradeRewards/contract.js';
import { TRADE_REWARDS_MAX_PAYOUT } from '../../src/tradeRewards/config.js';

describe('assertRewardsFunding', () => {
  it('accepts exact campaign funding', () => {
    expect(() => assertRewardsFunding(TRADE_REWARDS_MAX_PAYOUT, 0n)).not.toThrow();
  });

  it('accepts unsolicited excess token transfers', () => {
    expect(() => assertRewardsFunding(TRADE_REWARDS_MAX_PAYOUT + 1n, 0n)).not.toThrow();
  });

  it('accounts for rewards already paid', () => {
    expect(() => assertRewardsFunding(140_000_000n, 10_000_000n)).not.toThrow();
  });

  it('rejects an underfunded campaign', () => {
    expect(() => assertRewardsFunding(TRADE_REWARDS_MAX_PAYOUT - 1n, 0n)).toThrow(
      'rewards funding invariant failed',
    );
  });
});
