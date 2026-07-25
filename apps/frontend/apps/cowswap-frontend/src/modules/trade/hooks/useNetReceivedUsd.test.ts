import { CurrencyAmount, Price, Token } from '@cowprotocol/currency'

import { renderHook } from '@testing-library/react'

import { useUsdAmount } from 'modules/usdAmount'

import { useNetReceivedUsd } from './useNetReceivedUsd'
import { useShouldPayGas } from './useShouldPayGas'

import { ReceiveAmountInfo } from '../types'

jest.mock('modules/usdAmount', () => ({
  useUsdAmount: jest.fn(),
}))

jest.mock('./useShouldPayGas', () => ({
  useShouldPayGas: jest.fn(),
}))

const useUsdAmountMock = useUsdAmount as jest.MockedFunction<typeof useUsdAmount>
const useShouldPayGasMock = useShouldPayGas as jest.MockedFunction<typeof useShouldPayGas>

const TOKEN_A = new Token(1, '0x0000000000000000000000000000000000000001', 6, 'TOKEN_A', 'Token A')
const TOKEN_B = new Token(1, '0x0000000000000000000000000000000000000002', 6, 'TOKEN_B', 'Token B')

// 1:1 quote over 1_000 units (6 decimals).
const BASE_AMOUNT = '1000000000'
// Network fee: 10 units.
const NETWORK_FEE = '10000000'
// Partner (Ophis volume) fee: 3 units.
const PARTNER_FEE = '3000000'

interface FixtureParams {
  isSell?: boolean
  networkFeeRaw?: string
  partnerFeeRaw?: string
  bridgeFeeRaw?: string
}

function createInfo(params: FixtureParams = {}): ReceiveAmountInfo {
  const { isSell = true, networkFeeRaw = NETWORK_FEE, partnerFeeRaw = PARTNER_FEE, bridgeFeeRaw } = params

  const feeCurrency = isSell ? TOKEN_B : TOKEN_A

  const sellAmount = CurrencyAmount.fromRawAmount(TOKEN_A, BASE_AMOUNT)
  const buyAmount = CurrencyAmount.fromRawAmount(TOKEN_B, BASE_AMOUNT)
  const partnerFeeAmount = CurrencyAmount.fromRawAmount(feeCurrency, partnerFeeRaw)

  const afterPartnerFees = {
    sellAmount: isSell ? sellAmount : sellAmount.subtract(CurrencyAmount.fromRawAmount(TOKEN_A, partnerFeeRaw)),
    buyAmount: isSell ? buyAmount.subtract(CurrencyAmount.fromRawAmount(TOKEN_B, partnerFeeRaw)) : buyAmount,
  }

  return {
    isSell,
    quotePrice: new Price(TOKEN_A, TOKEN_B, BASE_AMOUNT, BASE_AMOUNT),
    costs: {
      networkFee: {
        amountInSellCurrency: CurrencyAmount.fromRawAmount(TOKEN_A, networkFeeRaw),
        amountInBuyCurrency: CurrencyAmount.fromRawAmount(TOKEN_B, networkFeeRaw),
      },
      partnerFee: {
        amount: partnerFeeAmount,
        bps: partnerFeeRaw === '0' ? 0 : 10,
      },
      ...(bridgeFeeRaw
        ? {
            bridgeFee: {
              amountInIntermediateCurrency: CurrencyAmount.fromRawAmount(TOKEN_B, bridgeFeeRaw),
              amountInDestinationCurrency: CurrencyAmount.fromRawAmount(TOKEN_B, bridgeFeeRaw),
            },
          }
        : {}),
    },
    beforeAllFees: { sellAmount, buyAmount },
    beforeNetworkCosts: { sellAmount, buyAmount },
    afterNetworkCosts: { sellAmount, buyAmount },
    afterPartnerFees,
    afterSlippage: afterPartnerFees,
    amountsToSign: { sellAmount, buyAmount },
  }
}

describe('useNetReceivedUsd', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    useShouldPayGasMock.mockReturnValue(false)
    // Identity pricing: USD value mirrors the token amount, so the math is observable.
    useUsdAmountMock.mockImplementation((amount) => ({
      value: amount ? (amount as CurrencyAmount<Token>) : null,
      isLoading: false,
    }))
  })

  it('sell order: nets the buy amount after fees with kind receive', () => {
    const { result } = renderHook(() => useNetReceivedUsd(createInfo({ isSell: true })))

    expect(result.current.kind).toBe('receive')
    // 1_000 - 3 (partner fee) = 997 TOKEN_B
    expect(result.current.netAmount?.toExact()).toBe('997')
    expect(result.current.netUsd?.toExact()).toBe('997')
    // Total costs = network fee (10) + partner fee (3)
    expect(result.current.totalCosts?.toExact()).toBe('13')
    expect(result.current.userPaysGasOnTop).toBe(false)
  })

  it('buy order inversion: nets the sell amount after fees with kind pay', () => {
    const { result } = renderHook(() => useNetReceivedUsd(createInfo({ isSell: false })))

    expect(result.current.kind).toBe('pay')
    // Buy orders headline what the user spends: 1_000 - 3 = 997 TOKEN_A
    expect(result.current.netAmount?.toExact()).toBe('997')
    expect(result.current.netAmount?.currency).toBe(TOKEN_A)
  })

  it('bridge fee is subtracted from the net amount on sell orders', () => {
    const { result } = renderHook(() => useNetReceivedUsd(createInfo({ isSell: true, bridgeFeeRaw: '7000000' })))

    // 1_000 - 3 (partner) - 7 (bridge) = 990 TOKEN_B
    expect(result.current.netAmount?.toExact()).toBe('990')
  })

  it('zero fee: net equals gross and total costs are zero', () => {
    const { result } = renderHook(() =>
      useNetReceivedUsd(createInfo({ isSell: true, networkFeeRaw: '0', partnerFeeRaw: '0' })),
    )

    expect(result.current.netAmount?.toExact()).toBe('1000')
    expect(result.current.netUsd?.toExact()).toBe('1000')
    expect(result.current.totalCosts?.equalTo(0)).toBe(true)
  })

  it('fee larger than output: hides the headline instead of showing a non-positive net', () => {
    // Bridge fee (1_100) exceeds the whole buy amount (1_000 - 3 after partner fee).
    const { result } = renderHook(() => useNetReceivedUsd(createInfo({ isSell: true, bridgeFeeRaw: '1100000000' })))

    expect(result.current.netAmount).toBeNull()
    expect(result.current.netUsd).toBeNull()
    expect(result.current.grossUsd).toBeNull()
    expect(result.current.totalCostsUsd).toBeNull()
  })

  it('missing USD price: keeps the token amount for the native fallback display', () => {
    useUsdAmountMock.mockReturnValue({ value: null, isLoading: false })

    const { result } = renderHook(() => useNetReceivedUsd(createInfo({ isSell: true })))

    expect(result.current.netAmount?.toExact()).toBe('997')
    expect(result.current.netUsd).toBeNull()
    expect(result.current.grossUsd).toBeNull()
    expect(result.current.totalCostsUsd).toBeNull()
  })

  it('propagates the pay-gas-on-top flag', () => {
    useShouldPayGasMock.mockReturnValue(true)

    const { result } = renderHook(() => useNetReceivedUsd(createInfo()))

    expect(result.current.userPaysGasOnTop).toBe(true)
  })

  it('returns empty state without a quote', () => {
    const { result } = renderHook(() => useNetReceivedUsd(null))

    expect(result.current.netAmount).toBeNull()
    expect(result.current.netUsd).toBeNull()
    expect(result.current.totalCosts).toBeNull()
  })
})
