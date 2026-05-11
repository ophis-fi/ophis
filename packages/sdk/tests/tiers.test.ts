import { describe, it, expect } from 'vitest';
import { TIERS, POOL_SPLIT_BPS, assignTier as sdkAssign } from '@greg/sdk';

// The indexer ships its own TS source. We import it directly and compare exports.
// If the workspace layout moves the indexer, this import path breaks and the test
// fails loudly — which is what we want (it reminds us to update the mirror).
import {
  TIERS as INDEXER_TIERS,
  POOL_SPLIT_BPS as INDEXER_POOL,
  assignTier as indexerAssign,
} from '../../../apps/rebate-indexer/src/tiers.js';

describe('@greg/sdk tiers mirror apps/rebate-indexer/src/tiers.ts', () => {
  it('TIERS array matches the indexer source exactly', () => {
    expect(TIERS).toEqual(INDEXER_TIERS);
  });

  it('POOL_SPLIT_BPS matches the indexer source', () => {
    expect(POOL_SPLIT_BPS).toBe(INDEXER_POOL);
  });

  it.each([0, 4_999.99, 5_000, 49_999.99, 50_000, 499_999.99, 500_000, 1_000_000_000])(
    'assignTier(%s) matches indexer behaviour',
    (volume) => {
      expect(sdkAssign(volume)).toEqual(indexerAssign(volume));
    },
  );
});
