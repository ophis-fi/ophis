import { StatusColorVariant } from '@cowprotocol/ui'

import { getTrustedTokenTags } from './getTrustedTokenTags.utils'

const tokenListTags = {
  ondo: { id: 'ondo', name: 'Tokenized by Ondo', description: 'Ondo asset', color: StatusColorVariant.Info },
  xStocks: { id: 'xStocks', name: 'xStock', description: 'xStocks asset', color: StatusColorVariant.Info },
  stablecoin: { id: 'stablecoin', name: 'Stablecoin', description: 'Stablecoin' },
}

describe('getTrustedTokenTags', () => {
  it('removes provider claims from unvalidated raw token tags', () => {
    expect(getTrustedTokenTags(['ondo', 'xStocks', 'stablecoin'], tokenListTags, undefined)).toEqual([
      tokenListTags.stablecoin,
    ])
  })

  it('adds only the provider validated by configured-list metadata', () => {
    expect(getTrustedTokenTags(['xStocks', 'stablecoin'], tokenListTags, 'ondo')).toEqual([
      tokenListTags.stablecoin,
      tokenListTags.ondo,
    ])
  })
})
