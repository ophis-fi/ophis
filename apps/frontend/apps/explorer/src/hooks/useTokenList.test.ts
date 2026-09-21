import { SupportedChainId } from '@cowprotocol/cow-sdk'
import { OPHIS_TOKENS_LIST_SOURCE } from '@cowprotocol/tokens'
import type { TokenInfo } from '@uniswap/token-lists'

import { renderHook } from '@testing-library/react'

import { useTokenList } from './useTokenList'
import { useTokenListByUrl } from './useTokenListByUrl'

jest.mock('@cowprotocol/tokens', () => ({
  OPHIS_TOKENS_LIST_SOURCE: 'https://swap.ophis.fi/token-lists/ophis.json',
}))
jest.mock('./useTokenListByUrl', () => ({ useTokenListByUrl: jest.fn() }))
jest.mock('../const', () => ({ NATIVE_TOKEN_PER_NETWORK: {} }))

const token: TokenInfo = {
  chainId: 1,
  address: '0x0000000000000000000000000000000000000001',
  name: 'Reviewed token',
  symbol: 'TOKEN',
  decimals: 6,
}
const supplement = { ...token, address: '0x0000000000000000000000000000000000000002' }

describe('explorer token lists', () => {
  it('keeps supplemental entries, gives Ophis precedence and isolates chains', () => {
    const own = [token]
    const external = [{ ...token, decimals: 18 }, supplement]
    jest.mocked(useTokenListByUrl).mockImplementation(
      (url) =>
        ({
          data: url === OPHIS_TOKENS_LIST_SOURCE ? own : external,
          isLoading: false,
        }) as ReturnType<typeof useTokenListByUrl>,
    )
    const { result, rerender } = renderHook(({ chain }) => useTokenList(chain), {
      initialProps: { chain: SupportedChainId.MAINNET },
    })
    expect(result.current.data).toEqual({ [token.address]: token, [supplement.address]: supplement })
    rerender({ chain: SupportedChainId.BASE })
    expect(result.current.data).toEqual({})
    expect(own).toEqual([token])
    expect(external[0].decimals).toBe(18)
  })

  it('keeps available Ophis metadata while a supplement loads; handles no selected chain', () => {
    jest.mocked(useTokenListByUrl).mockImplementation(
      (url) =>
        ({
          data: url === OPHIS_TOKENS_LIST_SOURCE ? [token] : undefined,
          isLoading: url !== OPHIS_TOKENS_LIST_SOURCE,
        }) as ReturnType<typeof useTokenListByUrl>,
    )
    const { result } = renderHook(() => useTokenList(SupportedChainId.MAINNET))
    expect(result.current).toEqual({ data: { [token.address]: token }, isLoading: true })
    const missing = renderHook(() => useTokenList(undefined))
    expect(missing.result.current).toEqual({ data: {}, isLoading: false })
  })
})
