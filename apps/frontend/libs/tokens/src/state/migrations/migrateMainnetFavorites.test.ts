import { DAI, EURE_MAINNET, USDC_MAINNET, USDT, WBTC, WETH_MAINNET } from '@cowprotocol/common-const'
import { getAddressKey } from '@cowprotocol/cow-sdk'

import { migrateMainnetFavorites } from './migrateMainnetFavorites'

import { DEFAULT_FAVORITE_TOKENS } from '../../const/defaultFavoriteTokens'

beforeEach(() => localStorage.clear())

it('replaces the old Ethereum shortcuts in order, retaining custom tokens and other chains', () => {
  const custom = { ...DAI, address: '0x0000000000000000000000000000000000000001', symbol: 'CUSTOM' }
  const old = {
    1: Object.fromEntries(
      [DAI, USDC_MAINNET, USDT, WBTC, WETH_MAINNET, EURE_MAINNET, custom].map((token) => [token.address, token]),
    ),
    8453: { custom },
  }
  localStorage.setItem('favoriteTokensAtom:v5', JSON.stringify(old))
  migrateMainnetFavorites()
  const migrated = JSON.parse(localStorage.getItem('favoriteTokensAtom:v6') || '{}')
  expect(migrated[1]).toEqual({ ...DEFAULT_FAVORITE_TOKENS[1], [custom.address]: custom })
  expect(Object.values(DEFAULT_FAVORITE_TOKENS[1]).map((token) => token.symbol)).toEqual([
    'USDT',
    'USDC',
    'AAPLon',
    'AMZNon',
    'NVDAon',
    'EURC',
  ])
  expect(migrated[1][getAddressKey(USDC_MAINNET.address)].decimals).toBe(6)
  expect(migrated[8453]).toEqual(old[8453])
  expect(localStorage.getItem('favoriteTokensAtom:v5')).toBe(JSON.stringify(old))

  // A later manual removal must survive reloads.
  localStorage.setItem('favoriteTokensAtom:v6', '{}')
  migrateMainnetFavorites()
  expect(localStorage.getItem('favoriteTokensAtom:v6')).toBe('{}')
})

it('leaves absent Ethereum state to the defaults and upgrades an empty selection', () => {
  localStorage.setItem('favoriteTokensAtom:v5', '{"8453":{}}')
  migrateMainnetFavorites()
  expect(JSON.parse(localStorage.getItem('favoriteTokensAtom:v6') || '{}')).toEqual({ 8453: {} })
  localStorage.removeItem('favoriteTokensAtom:v6')
  localStorage.setItem('favoriteTokensAtom:v5', '{"1":{}}')
  migrateMainnetFavorites()
  expect(JSON.parse(localStorage.getItem('favoriteTokensAtom:v6') || '{}')[1]).toEqual(DEFAULT_FAVORITE_TOKENS[1])
})

it.each([null, 'invalid', 'null', '[]', '{"1":null}', '{"1":[]}'])(
  'preserves invalid or missing storage: %s',
  (raw) => {
    if (raw !== null) localStorage.setItem('favoriteTokensAtom:v5', raw)
    expect(migrateMainnetFavorites).not.toThrow()
    expect(localStorage.getItem('favoriteTokensAtom:v6')).toBeNull()
    expect(localStorage.getItem('favoriteTokensAtom:v5')).toBe(raw)
  },
)
