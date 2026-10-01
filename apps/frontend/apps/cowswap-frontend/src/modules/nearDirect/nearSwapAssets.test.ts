import { NATIVE_CURRENCIES } from '@cowprotocol/common-const'
import { AdditionalTargetChainId } from '@cowprotocol/cow-sdk'
import { Token } from '@cowprotocol/currency'

import fixture from './fixtures/monadDeposit.json'
import { NearToken } from './nearDirect.schemas'
import { findNearToken, nearTokenCurrency, nearTokenPickerOptions } from './nearSwapAssets.utils'

jest.mock('modules/tokensList', () => ({
  mapChainInfo: (id: number, info: { label: string }) => ({ id, label: info.label }),
}))

const tokens: NearToken[] = [fixture.source, fixture.destination]

it('keeps chain and decimals bound to the exact live asset', () => {
  const currency = nearTokenCurrency(tokens[0])
  expect(currency).toBeDefined()
  expect(findNearToken(tokens, currency ?? null)).toEqual(tokens[0])
  expect(findNearToken(tokens, new Token(1, fixture.source.contractAddress, 6, 'USDC'))).toBeUndefined()
  expect(findNearToken(tokens, new Token(143, fixture.source.contractAddress, 18, 'USDC'))).toBeUndefined()
})

it('does not map ambiguous asset ids to the same token', () => {
  const duplicate = [...tokens, { ...tokens[0], assetId: 'different-asset' }]
  expect(findNearToken(duplicate, nearTokenCurrency(tokens[0]) ?? null)).toBeUndefined()
  expect(nearTokenPickerOptions(duplicate).tokens).toHaveLength(1)
})

it('preserves case-sensitive non-EVM token identity', () => {
  const sol: NearToken = {
    assetId: 'sol-usdc',
    blockchain: 'sol',
    contractAddress: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    symbol: 'USDC',
    decimals: 6,
    price: 1,
  }
  expect(findNearToken([sol], nearTokenCurrency(sol) ?? null)).toEqual(sol)
  expect(
    findNearToken([sol], nearTokenCurrency({ ...sol, contractAddress: sol.contractAddress?.toLowerCase() }) ?? null),
  ).toBeUndefined()
})

it('excludes native-looking duplicates instead of aliasing BTC', () => {
  const native = NATIVE_CURRENCIES[AdditionalTargetChainId.BITCOIN]
  const btc: NearToken = { assetId: 'btc', blockchain: 'btc', symbol: 'BTC', decimals: native.decimals, price: 1 }
  expect(nearTokenCurrency(btc)?.address).toBe(native.address)
  expect(nearTokenCurrency({ ...btc, assetId: 'omni', symbol: 'BTC(OMNI)' })).toBeUndefined()
})

it('keeps Sui Move type names case-sensitive', () => {
  const sui: NearToken = {
    assetId: 'sui-usdc',
    blockchain: 'sui',
    contractAddress: '0x2::coin::USDC',
    symbol: 'USDC',
    decimals: 6,
    price: 1,
  }
  expect(findNearToken([sui], nearTokenCurrency(sui) ?? null)).toEqual(sui)
  expect(
    findNearToken([sui], nearTokenCurrency({ ...sui, contractAddress: '0x2::coin::usdc' }) ?? null),
  ).toBeUndefined()
})

it('does not alias case variants of the native Sui type', () => {
  const sui: NearToken = {
    assetId: 'sui',
    blockchain: 'sui',
    contractAddress: '0x2::sui::SUI',
    symbol: 'SUI',
    decimals: 9,
    price: 1,
  }
  expect(findNearToken([sui], nearTokenCurrency({ ...sui, contractAddress: '0x2::sui::sui' }) ?? null)).toBeUndefined()
})

it('normalizes EVM checksum casing through the shared address key', () => {
  const token = { ...fixture.source, contractAddress: '0x754704BC059F8C67012FED69BC8A327A5AAFB603' }
  expect(findNearToken([token], nearTokenCurrency(fixture.source) ?? null)).toEqual(token)
})
