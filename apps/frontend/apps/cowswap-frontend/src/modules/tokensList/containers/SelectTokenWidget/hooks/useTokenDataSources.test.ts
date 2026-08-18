import { getTokenId } from '@cowprotocol/cow-sdk'
import { ListState } from '@cowprotocol/tokens'

import { getConfiguredTokenListDisplayMetadata } from './useTokenDataSources'

const CONFIGURED_SOURCE = 'https://tokens.ophis.fi/default.json'
const USER_SOURCE = 'https://example.invalid/user-list.json'
const CONFIGURED_TOKEN = {
  chainId: 1,
  address: '0x0000000000000000000000000000000000000001',
  decimals: 18,
  symbol: 'ON',
  name: 'Configured token (Ondo Tokenized)',
  tags: ['ondo'],
}
const USER_TOKEN = {
  chainId: 1,
  address: '0x0000000000000000000000000000000000000002',
  decimals: 18,
  symbol: 'USER',
  name: 'User token xStock',
  tags: ['xStocks'],
}

function createList(source: string, token: typeof CONFIGURED_TOKEN | typeof USER_TOKEN): ListState {
  return {
    source,
    list: {
      name: source,
      timestamp: '2026-08-19T00:00:00.000Z',
      version: { major: 1, minor: 0, patch: 0 },
      tokens: [token],
    },
  }
}

describe('getConfiguredTokenListDisplayMetadata', () => {
  it('trusts configured list membership and ignores user-added lists', () => {
    const result = getConfiguredTokenListDisplayMetadata(
      [createList(CONFIGURED_SOURCE, CONFIGURED_TOKEN), createList(USER_SOURCE, USER_TOKEN)],
      new Set([CONFIGURED_SOURCE]),
    )

    const configuredTokenId = getTokenId(CONFIGURED_TOKEN)
    const userTokenId = getTokenId(USER_TOKEN)

    expect(result.verifiedTokenIds.has(configuredTokenId)).toBe(true)
    expect(result.tokenizedAssetProviderByTokenId.get(configuredTokenId)).toBe('ondo')
    expect(result.verifiedTokenIds.has(userTokenId)).toBe(false)
    expect(result.tokenizedAssetProviderByTokenId.has(userTokenId)).toBe(false)
  })
})
