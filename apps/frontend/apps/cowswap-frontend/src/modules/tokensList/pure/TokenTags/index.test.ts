import { StatusColorVariant } from '@cowprotocol/ui'

import { getTrustedTokenTags } from './getTrustedTokenTags.utils'

const tokenListTags = {
  ondo: { id: 'ondo', name: 'Tokenized by Ondo', description: 'Ondo asset', color: StatusColorVariant.Info },
  xStocks: { id: 'xStocks', name: 'xStock', description: 'xStocks asset', color: StatusColorVariant.Info },
  bStocks: { id: 'bStocks', name: 'bStocks', description: 'bStocks asset', color: StatusColorVariant.Info },
  reality: { id: 'reality', name: 'Reality', description: 'Reality asset', color: StatusColorVariant.Info },
  circle: { id: 'circle', name: 'Official Circle', description: 'Circle asset' },
  robinhood: { id: 'robinhood', name: 'Robinhood', description: 'Robinhood asset' },
  stablecoin: { id: 'stablecoin', name: 'Stablecoin', description: 'Stablecoin' },
}

describe('getTrustedTokenTags', () => {
  it('removes provider claims from unvalidated raw token tags', () => {
    expect(
      getTrustedTokenTags(
        ['ondo', 'xStocks', 'bStocks', 'reality', 'circle', 'robinhood', 'stablecoin'],
        tokenListTags,
        undefined,
      ),
    ).toEqual([tokenListTags.stablecoin])
  })

  it('adds only the provider validated by configured-list metadata', () => {
    expect(getTrustedTokenTags(['xStocks', 'stablecoin'], tokenListTags, 'ondo')).toEqual([
      tokenListTags.stablecoin,
      tokenListTags.ondo,
    ])
  })

  it.each(['bStocks', 'reality'] as const)('shows %s without trusting competing raw provider tags', (provider) => {
    expect(getTrustedTokenTags(['xStocks', 'bStocks', 'reality'], tokenListTags, provider)).toEqual([
      tokenListTags[provider],
    ])
  })
})
