import { WETH_MAINNET } from '@cowprotocol/common-const'

import { renderHook } from '@testing-library/react'

import { useUsdAmount } from 'modules/usdAmount'

import { reviewedOtcToken } from './otcWriteForm'
import { useOtcUsdAmount } from './useOtcUsdAmount'

jest.mock('modules/usdAmount', () => ({ useUsdAmount: jest.fn() }))

const useUsdAmountMock = useUsdAmount as jest.MockedFunction<typeof useUsdAmount>
const USD_VALUE = { toFixed: () => '12.34' } as never

describe('useOtcUsdAmount', () => {
  beforeEach(() => {
    useUsdAmountMock.mockReset()
    useUsdAmountMock.mockReturnValue({ value: USD_VALUE, isLoading: false })
  })

  it('stabilizes its currency amount and result when inputs do not change', () => {
    const token = reviewedOtcToken(WETH_MAINNET.address)
    if (!token) throw new Error('WETH must remain an OTC-reviewed token')
    const { result, rerender } = renderHook(() => useOtcUsdAmount(token, 1n))
    const firstAmount = useUsdAmountMock.mock.calls[0][0]
    const firstResult = result.current

    rerender()

    expect(useUsdAmountMock.mock.calls[1][0]).toBe(firstAmount)
    expect(result.current).toBe(firstResult)
    expect(result.current.value).toBe('12.34')
  })

  it('keeps a zero raw amount as a stable CurrencyAmount', () => {
    const token = reviewedOtcToken(WETH_MAINNET.address)
    if (!token) throw new Error('WETH must remain an OTC-reviewed token')
    renderHook(() => useOtcUsdAmount(token, 0n))

    expect(useUsdAmountMock.mock.calls[0][0]).not.toBeNull()
  })
})
