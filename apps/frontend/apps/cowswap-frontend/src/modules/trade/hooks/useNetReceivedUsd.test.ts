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

function raw(token: Token, value: string): CurrencyAmount<Token> {
  return CurrencyAmount.fromRawAmount(token, value)
}

/**
 * Builds a realistic ReceiveAmountInfo where afterPartnerFees already has the
 * network and partner fees applied: sell orders deduct them from the buy side,
 * buy orders add them to the sell side (you pay more). This mirrors the real
 * getReceiveAmountInfo chain, so `amountBeforeFees - totalCosts == netAmount`
 * holds for sell orders exactly as it does in production.
 */
function createInfo(params: FixtureParams = {}): ReceiveAmountInfo {
  const { isSell = true, networkFeeRaw = NETWORK_FEE, partnerFeeRaw = PARTNER_FEE, bridgeFeeRaw } = params

  const sellAmount = raw(TOKEN_A, BASE_AMOUNT)
  const buyAmount = raw(TOKEN_B, BASE_AMOUNT)

  const networkFeeSell = raw(TOKEN_A, networkFeeRaw)
  const networkFeeBuy = raw(TOKEN_B, networkFeeRaw)
  const partnerFeeAmount = raw(isSell ? TOKEN_B : TOKEN_A, partnerFeeRaw)

  const afterPartnerFees = isSell
    ? {
        sellAmount,
        buyAmount: buyAmount.subtract(networkFeeBuy).subtract(raw(TOKEN_B, partnerFeeRaw)),
      }
    : {
        sellAmount: sellAmount.add(networkFeeSell).add(raw(TOKEN_A, partnerFeeRaw)),
        buyAmount,
      }

  return {
    isSell,
    quotePrice: new Price(TOKEN_A, TOKEN_B, BASE_AMOUNT, BASE_AMOUNT),
    costs: {
      networkFee: {
        amountInSellCurrency: networkFeeSell,
        amountInBuyCurrency: networkFeeBuy,
      },
      partnerFee: {
        amount: partnerFeeAmount,
        bps: partnerFeeRaw === '0' ? 0 : 10,
      },
      ...(bridgeFeeRaw
        ? {
            bridgeFee: {
              amountInIntermediateCurrency: raw(TOKEN_B, bridgeFeeRaw),
              amountInDestinationCurrency: raw(TOKEN_B, bridgeFeeRaw),
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

  it('sell order: nets the buy amount after network and partner fees, kind receive', () => {
    const { result } = renderHook(() => useNetReceivedUsd(createInfo({ isSell: true })))

    expect(result.current.kind).toBe('receive')
    // 1_000 - 10 (network) - 3 (partner) = 987 TOKEN_B
    expect(result.current.netAmount?.toExact()).toBe('987')
    expect(result.current.netUsd?.toExact()).toBe('987')
    // Total costs = network fee (10) + partner fee (3)
    expect(result.current.totalCosts?.toExact()).toBe('13')
    expect(result.current.userPaysGasOnTop).toBe(false)
  })

  it('buy order inversion: nets the sell amount after fees with kind pay', () => {
    const { result } = renderHook(() => useNetReceivedUsd(createInfo({ isSell: false })))

    expect(result.current.kind).toBe('pay')
    // Buy orders headline what the user spends: 1_000 + 10 (network) + 3 (partner) = 1013 TOKEN_A
    expect(result.current.netAmount?.toExact()).toBe('1013')
    expect(result.current.netAmount?.currency).toBe(TOKEN_A)
  })

  it('bridge fee is subtracted from the net amount on sell orders', () => {
    const { result } = renderHook(() => useNetReceivedUsd(createInfo({ isSell: true, bridgeFeeRaw: '7000000' })))

    // 1_000 - 10 (network) - 3 (partner) - 7 (bridge) = 980 TOKEN_B
    expect(result.current.netAmount?.toExact()).toBe('980')
  })

  it('bridge swap reconciles: headline == before - totalCosts (totalCosts includes the bridge fee)', () => {
    const { result } = renderHook(() => useNetReceivedUsd(createInfo({ isSell: true, bridgeFeeRaw: '7000000' })))

    // totalCosts must fold in the bridge fee so the tooltip breakdown adds up
    // and agrees with the accordion header. network (10) + partner (3) + bridge (7) = 20
    expect(result.current.totalCosts?.toExact()).toBe('20')

    // With identity pricing, USD mirrors the token amount: net == gross - totalCosts.
    // gross = amountBeforeFees = 1000, totalCosts = 20 -> net = 980.
    const grossUsd = Number(result.current.grossUsd?.toExact())
    const totalCostsUsd = Number(result.current.totalCostsUsd?.toExact())
    const netUsd = Number(result.current.netUsd?.toExact())
    expect(netUsd).toBe(grossUsd - totalCostsUsd)
    expect(netUsd).toBe(980)
  })

  it('non-bridge sell order also reconciles: net == before - totalCosts', () => {
    const { result } = renderHook(() => useNetReceivedUsd(createInfo({ isSell: true })))

    const grossUsd = Number(result.current.grossUsd?.toExact())
    const totalCostsUsd = Number(result.current.totalCostsUsd?.toExact())
    const netUsd = Number(result.current.netUsd?.toExact())
    expect(netUsd).toBe(grossUsd - totalCostsUsd)
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
    // Bridge fee (1_100) exceeds the whole buy amount (987 after network + partner).
    const { result } = renderHook(() => useNetReceivedUsd(createInfo({ isSell: true, bridgeFeeRaw: '1100000000' })))

    expect(result.current.netAmount).toBeNull()
    expect(result.current.netUsd).toBeNull()
    expect(result.current.grossUsd).toBeNull()
    expect(result.current.totalCostsUsd).toBeNull()
  })

  it('missing USD price: keeps the token amount for the native fallback display', () => {
    useUsdAmountMock.mockReturnValue({ value: null, isLoading: false })

    const { result } = renderHook(() => useNetReceivedUsd(createInfo({ isSell: true })))

    expect(result.current.netAmount?.toExact()).toBe('987')
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
