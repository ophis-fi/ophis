import assert from 'node:assert/strict';
import test from 'node:test';

import { isRobinhoodAsset } from '../../functions/api/robinhood/assets.ts';

const asset = {
  id: 'apple',
  tokenSymbol: 'AAPL',
  tokenName: 'Apple • Robinhood Token',
  deployments: [{ chainId: 4663, contractAddress: '0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9' }],
  currentMultiplier: '1.000000000000000000',
  status: 'ASSET_STATUS_ACTIVE',
  tradingCapabilities: {
    market: { whole: 'TRADING_STATUS_TRADABLE', fractional: 'TRADING_STATUS_TRADABLE' },
  },
};

test('accepts the documented Robinhood Stock Token shape', () => {
  assert.equal(isRobinhoodAsset(asset), true);
});

test('rejects malformed nested metadata before it reaches the swap UI', () => {
  assert.equal(isRobinhoodAsset({ ...asset, currentMultiplier: 'not-a-number' }), false);
  assert.equal(
    isRobinhoodAsset({
      ...asset,
      deployments: [{ chainId: 4663, contractAddress: 'javascript:alert(1)' }],
    }),
    false,
  );
  assert.equal(isRobinhoodAsset({ ...asset, tradingCapabilities: { market: 'tradable' } }), false);
});
