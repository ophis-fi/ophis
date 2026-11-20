import { useMemo } from 'react'

import { readAcrossV5Order } from '@cowprotocol/common-const'
import { CurrencyAmount } from '@cowprotocol/currency'

import { useBridgeSupportedNetwork } from 'entities/bridgeProvider'

import { useEstimatedBridgeBuyAmount } from 'modules/trade'
import { useTradeQuote } from 'modules/tradeQuote'
import { useUsdAmount } from 'modules/usdAmount'

import { useBridgeQuoteAmounts } from './useBridgeQuoteAmounts'
import { useBridgeQuoteRecipient } from './useBridgeQuoteRecipient'

import { QuoteBridgeContext } from '../types'

export function useQuoteBridgeContext(): QuoteBridgeContext | null {
  const { bridgeQuote } = useTradeQuote()

  const quoteAmounts = useBridgeQuoteAmounts()
  const bridgeFee = quoteAmounts?.bridgeFee
  const estimatedAmounts = useEstimatedBridgeBuyAmount()
  const buyAmount = estimatedAmounts?.expectedToReceiveAmount
  const expectedToReceiveAmount = useMemo(() => {
    if (!buyAmount || !bridgeFee) return null

    return buyAmount.subtract(bridgeFee)
  }, [buyAmount, bridgeFee])

  const { deposit, sellAmount, returnsSourceSurplus } = useMemo(
    () => bridgeDepositAmounts(quoteAmounts, bridgeQuote?.quoteBody),
    [quoteAmounts, bridgeQuote?.quoteBody],
  )

  const { value: buyAmountUsd } = useUsdAmount(buyAmount)
  const { value: bridgeMinDepositAmountUsd } = useUsdAmount(deposit)
  const { value: expectedToReceiveUsd } = useUsdAmount(expectedToReceiveAmount)
  const { value: bridgeMinReceiveAmountUsd } = useUsdAmount(quoteAmounts?.bridgeMinReceiveAmount)

  const targetChainId = quoteAmounts?.bridgeMinReceiveAmount.currency.chainId
  const destChainData = useBridgeSupportedNetwork(targetChainId)

  const expectedFillTimeSeconds = bridgeQuote?.expectedFillTimeSeconds || null
  const bridgeReceiverOverride = bridgeQuote?.bridgeReceiverOverride || null
  const recipient = useBridgeQuoteRecipient()

  return useMemo(() => {
    if (!quoteAmounts || !sellAmount || !recipient || !buyAmount) return null

    if (!destChainData) return null

    return {
      chainName: destChainData.label,
      bridgeFee: quoteAmounts.bridgeFee,
      estimatedTime: expectedFillTimeSeconds,
      recipient,
      sellAmount,
      buyAmount: buyAmount,
      bridgeReceiverOverride,
      bridgeMinDepositAmount: deposit,
      returnsSourceSurplus,
      bridgeMinReceiveAmount: quoteAmounts.bridgeMinReceiveAmount,
      bridgeMinReceiveAmountUsd,
      bridgeMinDepositAmountUsd,
      buyAmountUsd,
      expectedToReceive: expectedToReceiveAmount,
      expectedToReceiveUsd,
    }
  }, [
    quoteAmounts,
    returnsSourceSurplus,
    sellAmount,
    deposit,
    expectedFillTimeSeconds,
    recipient,
    destChainData,
    buyAmount,
    buyAmountUsd,
    bridgeMinDepositAmountUsd,
    bridgeReceiverOverride,
    expectedToReceiveAmount,
    expectedToReceiveUsd,
    bridgeMinReceiveAmountUsd,
  ])
}

function bridgeDepositAmounts(
  amounts: ReturnType<typeof useBridgeQuoteAmounts>,
  quoteBody: string | undefined,
): {
  deposit: QuoteBridgeContext['bridgeMinDepositAmount']
  sellAmount: QuoteBridgeContext['sellAmount'] | null | undefined
  returnsSourceSurplus: boolean
} {
  const fixed = readAcrossV5Order(quoteBody)?.amount
  const minimum = amounts?.swapMinReceiveAmount
  if (minimum && fixed) {
    const deposit = CurrencyAmount.fromRawAmount(minimum.currency, fixed)
    return { deposit, sellAmount: deposit, returnsSourceSurplus: true }
  }
  return { deposit: minimum ?? null, sellAmount: amounts?.swapExpectedReceive, returnsSourceSurplus: false }
}
