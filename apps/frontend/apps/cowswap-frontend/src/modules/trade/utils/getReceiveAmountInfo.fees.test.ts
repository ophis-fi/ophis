import { bpsToPercent } from '@cowprotocol/common-utils'
import { OrderKind } from '@cowprotocol/cow-sdk'
import { Percent, Token } from '@cowprotocol/currency'

import { getReceiveAmountInfo } from './getReceiveAmountInfo'

const sellToken = new Token(1, '0x0000000000000000000000000000000000000001', 6)
const buyToken = new Token(1, '0x0000000000000000000000000000000000000002', 6)

it.each([
  [OrderKind.BUY, '1005100.5', '1005200'],
  [OrderKind.SELL, '994899.5', '994800'],
])('separates fractional fees from the %s signing limit', (kind, expectedAmount, signingLimit) => {
  const info = getReceiveAmountInfo({
    orderParams: {
      kind,
      sellAmount: '1000000000000',
      buyAmount: '1000000000000',
      feeAmount: '0',
      sellToken: sellToken.address,
      buyToken: buyToken.address,
      validTo: 2000000000,
      appData: `0x${'0'.repeat(64)}`,
      partiallyFillable: false,
    },
    inputCurrency: sellToken,
    outputCurrency: buyToken,
    slippagePercent: new Percent(0),
    partnerFeeBps: 51.005,
    protocolFeeBps: undefined,
  })

  expect(info.costs.partnerFee.bps).toBe(51.005)
  expect(info.costs.partnerFee.amount.toExact()).toBe('5100.5')
  expect(bpsToPercent(info.costs.partnerFee.bps).toFixed(5)).toBe('0.51005')
  const side = kind === OrderKind.BUY ? 'sellAmount' : 'buyAmount'
  expect(info.afterPartnerFees[side].toExact()).toBe(expectedAmount)
  expect(info.amountsToSign[side].toExact()).toBe(signingLimit)
})
