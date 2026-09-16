import { NATIVE_CURRENCIES } from '@cowprotocol/common-const'
import { BigNumber } from '@ethersproject/bignumber'

import { renderHook } from '@testing-library/react'

import { useCurrencyAmountBalance } from './useCurrencyAmountBalance'
import { useTokensBalances } from './useTokensBalances'

import { DEFAULT_BALANCES_STATE } from '../state/balancesAtom'

jest.mock('./useTokensBalances')

it('rejects a native balance cached for another chain until Ethereum balances arrive', () => {
  const token = NATIVE_CURRENCIES[1]
  const cached = {
    ...DEFAULT_BALANCES_STATE,
    chainId: 100,
    fromCache: true,
    values: { [token.address.toLowerCase()]: BigNumber.from(1000) },
  }
  const balances = jest.mocked(useTokensBalances)
  balances.mockReturnValue(cached)
  const { result, rerender } = renderHook(() => useCurrencyAmountBalance(token))
  expect(result.current).toBeUndefined()
  balances.mockReturnValue({ ...cached, chainId: 1, values: { [token.address.toLowerCase()]: BigNumber.from(0) } })
  rerender()
  expect(result.current?.quotient.toString()).toBe('0')
  balances.mockReturnValue({ ...cached, chainId: 1 })
  rerender()
  expect(result.current?.quotient.toString()).toBe('1000')
})
