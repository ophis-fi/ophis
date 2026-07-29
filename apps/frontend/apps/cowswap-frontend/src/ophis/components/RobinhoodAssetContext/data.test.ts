import { findRobinhoodStockAsset, hasTradingRestriction } from './data'

import type { RobinhoodStockAsset } from './types'

const AAPL: RobinhoodStockAsset = {
  id: 'apple',
  tokenSymbol: 'AAPL',
  tokenName: 'Apple • Robinhood Token',
  deployments: [{ chainId: 4663, contractAddress: '0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9' }],
  currentMultiplier: '1.000000000000000000',
  status: 'ASSET_STATUS_ACTIVE',
  tradingCapabilities: {
    market: { whole: 'TRADING_STATUS_TRADABLE', fractional: 'TRADING_STATUS_TRADABLE' },
  },
}

describe('Robinhood Stock Token metadata', () => {
  it('matches only canonical Robinhood mainnet deployments', () => {
    expect(findRobinhoodStockAsset([AAPL], '0xaf3d76f1834a1d425780943c99ea8a608f8a93f9')).toBe(AAPL)
    expect(findRobinhoodStockAsset([AAPL], '0x0000000000000000000000000000000000000001')).toBeUndefined()
  })

  it('detects inactive assets and restricted sessions', () => {
    expect(hasTradingRestriction(AAPL)).toBe(false)
    expect(hasTradingRestriction({ ...AAPL, status: 'ASSET_STATUS_INACTIVE' })).toBe(true)
    expect(
      hasTradingRestriction({
        ...AAPL,
        tradingCapabilities: {
          market: { whole: 'TRADING_STATUS_POSITION_CLOSING_ONLY', fractional: 'TRADING_STATUS_TRADABLE' },
        },
      }),
    ).toBe(true)
  })
})
