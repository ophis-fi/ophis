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

// Ophis on-chain shape: CIP-75 price-improvement fee written into
// appData.metadata.partnerFee (recipient = the partner-fee Safe).
const FIXTURE_ORDER_PI = {
  ...FIXTURE_ORDER,
  fullAppData: JSON.stringify({
    version: '1.4.0',
    appCode: 'greg',
    metadata: {
      partnerFee: { priceImprovementBps: 2500, maxVolumeBps: 50, recipient: '0x858f0F5eE954846D47155F5203c04aF1819eCeF8' },
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
      type: 'volume',
      volumeBps: 5,
      recipient: '0xBA6Da6bB0fc6A3fABd69A3FCEb25Af4A35a8C76E',
    })
    expect(receipt.surplusVsQuote).toBeCloseTo(0.19, 2)
    expect(receipt.receiptVersion).toBe('2')
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

  it('extracts a CIP-75 price-improvement partner fee (Ophis on-chain shape)', () => {
    // Regression: the volumeBps-only extractor returned null here, so receipts
    // under-reported Ophis's real 25%-of-improvement fee as "(none)".
    const receipt = buildReceipt({ order: FIXTURE_ORDER_PI, trade: FIXTURE_TRADE, chainId: 10 })
    expect(receipt.partnerFee).toEqual({
      type: 'priceImprovement',
      priceImprovementBps: 2500,
      maxVolumeBps: 50,
      recipient: '0x858f0F5eE954846D47155F5203c04aF1819eCeF8',
    })
  })

  it('decodes a price-improvement fee missing its required maxVolumeBps cap to null', () => {
    // maxVolumeBps is the CIP-75-mandated ceiling; a PI fee without it is
    // malformed/foreign appData, so we report no fee rather than an uncapped one.
    const order = {
      ...FIXTURE_ORDER,
      fullAppData: JSON.stringify({
        metadata: { partnerFee: { priceImprovementBps: 2500, recipient: '0x858f0F5eE954846D47155F5203c04aF1819eCeF8' } },
      }),
    }
    expect(buildReceipt({ order, trade: FIXTURE_TRADE, chainId: 10 }).partnerFee).toBeNull()
  })

  it('decodes invalid appData JSON to null without throwing', () => {
    const order = { ...FIXTURE_ORDER, fullAppData: '{not valid json' }
    expect(() => buildReceipt({ order, trade: FIXTURE_TRADE, chainId: 10 })).not.toThrow()
    expect(buildReceipt({ order, trade: FIXTURE_TRADE, chainId: 10 }).partnerFee).toBeNull()
  })
})

import { exportJson } from './exportJson'

describe('exportJson', () => {
  it('produces a valid JSON string round-trippable to the original receipt', () => {
    const receipt = buildReceipt({ order: FIXTURE_ORDER, trade: FIXTURE_TRADE, chainId: 11155111 })
    const json = exportJson(receipt)
    const parsed = JSON.parse(json)
    expect(parsed.orderUid).toBe(receipt.orderUid)
    expect(parsed.partnerFee).toEqual(receipt.partnerFee)
    expect(parsed.receiptVersion).toBe('2')
    expect(parsed.executedBuyAmount).toBe(receipt.executedBuyAmount)
  })

  it('produces deterministic output: identical receipts yield identical JSON', () => {
    const receipt = buildReceipt({ order: FIXTURE_ORDER, trade: FIXTURE_TRADE, chainId: 11155111 })
    // The same receipt object exported twice must hash to the same string
    expect(exportJson(receipt)).toBe(exportJson(receipt))
  })
})

import { exportPdf } from './exportPdf'

describe('exportPdf', () => {
  it('produces a non-empty Blob with PDF mime type', () => {
    const receipt = buildReceipt({ order: FIXTURE_ORDER, trade: FIXTURE_TRADE, chainId: 11155111 })
    const blob = exportPdf(receipt)
    expect(blob).toBeInstanceOf(Blob)
    expect(blob.type).toBe('application/pdf')
    expect(blob.size).toBeGreaterThan(500)
  })

  it('does not throw on a not-yet-settled order (no trade)', () => {
    const receipt = buildReceipt({ order: { ...FIXTURE_ORDER, status: 'open', executedBuyAmount: '0' }, trade: null, chainId: 11155111 })
    expect(() => exportPdf(receipt)).not.toThrow()
  })

  it('renders a price-improvement fee (exercises the PI exporter arm)', () => {
    const receipt = buildReceipt({ order: FIXTURE_ORDER_PI, trade: FIXTURE_TRADE, chainId: 10 })
    const blob = exportPdf(receipt)
    expect(blob.type).toBe('application/pdf')
    expect(blob.size).toBeGreaterThan(500)
  })
})
