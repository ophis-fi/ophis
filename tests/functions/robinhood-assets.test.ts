import assert from 'node:assert/strict';
import test from 'node:test';

import { isRobinhoodAsset, sanitizeRobinhoodAsset } from '../../functions/api/robinhood/assets.ts';

const asset = {
  id: 'apple',
  tokenSymbol: 'AAPL',
  tokenName: 'Apple • Robinhood Token',
  deployments: [{ chainId: 4663, contractAddress: '0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9' }],
  currentMultiplier: '1.000000000000000000',
  pendingMultiplier: '',
  status: 'ASSET_STATUS_ACTIVE',
  tradingCapabilities: {
    market: { whole: 'TRADING_STATUS_TRADABLE', fractional: 'TRADING_STATUS_TRADABLE' },
  },
};

test('accepts the documented Robinhood Stock Token shape', () => {
  assert.equal(isRobinhoodAsset(asset), true);
  assert.equal(isRobinhoodAsset({ ...asset, pendingMultiplier: '2.000000000000000000' }), true);
});

test('rejects malformed nested metadata before it reaches the swap UI', () => {
  assert.equal(isRobinhoodAsset({ ...asset, currentMultiplier: 'not-a-number' }), false);
  assert.equal(isRobinhoodAsset({ ...asset, currentMultiplier: '0' }), false);
  assert.equal(isRobinhoodAsset({ ...asset, currentMultiplier: '0.000000000000000000' }), false);
  assert.equal(
    isRobinhoodAsset({
      ...asset,
      deployments: [{ chainId: 4663, contractAddress: 'javascript:alert(1)' }],
    }),
    false,
  );
  assert.equal(isRobinhoodAsset({ ...asset, tradingCapabilities: { market: 'tradable' } }), false);
  assert.equal(isRobinhoodAsset({ ...asset, tokenName: 'x'.repeat(257) }), false);
  assert.equal(
    isRobinhoodAsset({
      ...asset,
      deployments: Array.from({ length: 9 }, () => asset.deployments[0]),
    }),
    false,
  );
});

test('projects only validated documented fields', () => {
  const sanitized = sanitizeRobinhoodAsset({
    ...asset,
    ignoredTopLevel: 'not proxied',
    deployments: [{ ...asset.deployments[0], ignoredNested: 'not proxied' }],
  });
  assert.ok(sanitized);
  assert.equal('ignoredTopLevel' in sanitized, false);
  assert.equal('ignoredNested' in sanitized.deployments[0], false);
});
