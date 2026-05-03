import { buildReceipt } from './buildReceipt'

const FIXTURE_ORDER = {
  uid: '0x8e03c24db84f4e74bae2d869e989088d643164f869acf0bd5ba8806ee6e915a2412cbcce46fcba707a3190eced8113bbc2c294ab69f79657',
  owner: '0x412cbcce46fcba707a3190eced8113bbc2c294ab',
  status: 'fulfilled',
  sellToken: '0xfff9976782d46cc05630d1f6ebab18b2324d6b14',
  buyToken: '0x0625afb445c3b6b7b929342a04a22599fd5dbb59',
  sellAmount: '481015300000000',
  buyAmount: '21632297816389608',
  executedSellAmount: '481015300000000',
  executedBuyAmount: '25754879132324902',
  validTo: 1777833559,
  fullAppData: JSON.stringify({
    version: '1.4.0',
    appCode: 'greg',
    metadata: {
      partnerFee: { volumeBps: 5, recipient: '0xBA6Da6bB0fc6A3fABd69A3FCEb25Af4A35a8C76E' },
    },
  }),
}

const FIXTURE_TRADE = {
  blockNumber: 10783287,
  txHash: '0x00eb2964743676a6971c4dc58518a316000112a5b0de43a7a4a6ee9ad72d17e9',
  buyAmount: '25754879132324902',
  sellAmount: '481015300000000',
}

describe('buildReceipt', () => {
  it('produces a complete receipt for a fulfilled order with a trade', () => {
    const receipt = buildReceipt({ order: FIXTURE_ORDER, trade: FIXTURE_TRADE, chainId: 11155111 })
    expect(receipt.orderUid).toBe(FIXTURE_ORDER.uid)
    expect(receipt.chainId).toBe(11155111)
    expect(receipt.executedBuyAmount).toBe('25754879132324902')
    expect(receipt.settlementTxHash).toBe(FIXTURE_TRADE.txHash)
    expect(receipt.settlementBlock).toBe(10783287)
    expect(receipt.partnerFee).toEqual({
      volumeBps: 5,
      recipient: '0xBA6Da6bB0fc6A3fABd69A3FCEb25Af4A35a8C76E',
    })
    expect(receipt.surplusVsQuote).toBeCloseTo(0.19, 2)
    expect(receipt.receiptVersion).toBe('1')
    expect(typeof receipt.generatedAt).toBe('string')
  })

  it('handles missing trade (open or expired order)', () => {
    const receipt = buildReceipt({ order: { ...FIXTURE_ORDER, status: 'open', executedBuyAmount: '0' }, trade: null, chainId: 11155111 })
    expect(receipt.settlementTxHash).toBeNull()
    expect(receipt.settlementBlock).toBeNull()
    expect(receipt.executedBuyAmount).toBe('0')
    expect(receipt.surplusVsQuote).toBeNull()
  })

  it('handles missing partnerFee in fullAppData', () => {
    const noFeeOrder = {
      ...FIXTURE_ORDER,
      fullAppData: JSON.stringify({ version: '1.4.0', metadata: {} }),
    }
    const receipt = buildReceipt({ order: noFeeOrder, trade: FIXTURE_TRADE, chainId: 11155111 })
    expect(receipt.partnerFee).toBeNull()
  })
})
