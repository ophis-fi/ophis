import { expect, it } from 'vitest';
import { affiliatePayoutStatus } from '../../src/affiliate/payoutPlan.js';

it.each([
  [{}, 'disabled'],
  [{ AFFILIATE_PAYOUT_ENABLED: 'false' }, 'disabled'],
  [{ AFFILIATE_PAYOUT_ENABLED: 'true' }, 'not-configured'],
  [{ AFFILIATE_PAYOUT_ENABLED: 'true', SAFE_PROPOSER_PRIVATE_KEY: 'test-present', BATCHER_PROPOSE_ENABLED: 'false' }, 'dry-run'],
  [{ AFFILIATE_PAYOUT_ENABLED: 'true', SAFE_PROPOSER_PRIVATE_KEY: 'test-present', BATCHER_PROPOSE_ENABLED: 'typo' }, 'not-configured'],
  [{ AFFILIATE_PAYOUT_ENABLED: 'true', SAFE_PROPOSER_PRIVATE_KEY: 'test-present' }, 'scheduled'],
] as const)('reports readiness without promising execution: %j', (env, expected) => {
  expect(affiliatePayoutStatus(env)).toBe(expected);
});
