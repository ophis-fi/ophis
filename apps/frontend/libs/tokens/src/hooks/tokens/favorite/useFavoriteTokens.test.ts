import { useAtomValue } from 'jotai'

import { ARC_CHAIN_ID, TokenWithLogo } from '@cowprotocol/common-const'

import { renderHook } from '@testing-library/react'

import { useFavoriteTokens } from './useFavoriteTokens'

import { useTokensByAddressMap } from '../useTokensByAddressMap'

jest.mock('jotai', () => ({ ...jest.requireActual('jotai'), useAtomValue: jest.fn() }))
jest.mock('../../../state/tokens/favoriteTokensAtom', () => ({ favoriteTokensListAtom: {} }))
jest.mock('../useTokensByAddressMap', () => ({ useTokensByAddressMap: jest.fn() }))

test('refreshes saved artwork from the matching chain catalog without losing custom favorites', () => {
  const saved = new TokenWithLogo(undefined, ARC_CHAIN_ID, '0x7042f907266d5ff1c57529d36f9e8c731b569c10', 18, 'AAPLon')
  const custom = new TokenWithLogo(undefined, ARC_CHAIN_ID, '0x0000000000000000000000000000000000000001', 18, 'CUSTOM')
  const listed = TokenWithLogo.fromToken(saved, 'https://swap.ophis.fi/logos/token-aaplon.png')
  jest.mocked(useAtomValue).mockReturnValue([saved, custom])
  jest.mocked(useTokensByAddressMap).mockReturnValue({})
  const { result, rerender } = renderHook(useFavoriteTokens)
  expect(result.current).toEqual([saved, custom])

  jest.mocked(useTokensByAddressMap).mockReturnValue({ [saved.address.toLowerCase()]: listed })
  rerender()
  expect(result.current).toEqual([listed, custom])

  const otherChain = TokenWithLogo.fromToken({ ...saved, chainId: 1 }, listed.logoURI)
  jest.mocked(useTokensByAddressMap).mockReturnValue({ [saved.address.toLowerCase()]: otherChain })
  rerender()
  expect(result.current).toEqual([saved, custom])
})
