import { ARC_CHAIN_ID, ARC_CIRBTC, ARC_EURC, ARC_USDC, ARC_USYC } from '@cowprotocol/common-const'
import { getAddressKey } from '@cowprotocol/cow-sdk'

import { migrateArcFavorites } from './migrateArcFavorites'

it('upgrades existing two-token Arc shortcuts once while preserving all custom choices', () => {
  localStorage.clear()
  const custom = { ...ARC_USDC, address: '0x0000000000000000000000000000000000000001', symbol: 'CUSTOM' }
  const old = {
    1: { custom },
    [ARC_CHAIN_ID]: Object.fromEntries([ARC_USDC, ARC_EURC, custom].map((t) => [getAddressKey(t.address), t])),
  }
  localStorage.setItem('favoriteTokensAtom:v4', JSON.stringify(old))
  migrateArcFavorites()
  const migrated = JSON.parse(localStorage.getItem('favoriteTokensAtom:v5') || '{}')
  expect(migrated[1]).toEqual(old[1])
  for (const token of [ARC_USDC, ARC_EURC, ARC_CIRBTC, ARC_USYC, custom])
    expect(migrated[ARC_CHAIN_ID][getAddressKey(token.address)]).toMatchObject({ address: token.address })
  localStorage.setItem('favoriteTokensAtom:v5', '{}')
  migrateArcFavorites()
  expect(localStorage.getItem('favoriteTokensAtom:v5')).toBe('{}')
})
