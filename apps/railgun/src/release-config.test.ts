import { expect, it } from 'vitest'
import { validateRailgunAddress } from '@railgun-community/wallet'
import { FEE_SIGNER, PROTECTED_BROADCASTERS } from './config'

it('binds Ethereum discovery and protection to the reviewed Ophis fee identity with an explicit review expiry', () => {
  expect(validateRailgunAddress(FEE_SIGNER)).toBe(true)
  expect(Object.keys(PROTECTED_BROADCASTERS)).toEqual(['1'])
  expect(PROTECTED_BROADCASTERS[1]).toEqual([
    { railgunAddress: FEE_SIGNER, expiresAt: Date.parse('2026-12-03T00:00:00Z') },
  ])
})
