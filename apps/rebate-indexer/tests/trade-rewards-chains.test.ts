import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { TRADE_REWARDS_ELIGIBLE_CHAIN_IDS } from '../src/tradeRewards/config.js';

it('promotes tickets only on the chains accepted by the reward indexer', () => {
  const frontendChains = JSON.parse(readFileSync(new URL(
    '../../frontend/apps/cowswap-frontend/src/modules/affiliate/config/tradeRewards.json',
    import.meta.url,
  ), 'utf8'));
  expect(frontendChains).toEqual([...TRADE_REWARDS_ELIGIBLE_CHAIN_IDS]);
  for (const ineligible of [59144, 11155111, 999999]) {
    expect(frontendChains).not.toContain(ineligible);
  }
});
