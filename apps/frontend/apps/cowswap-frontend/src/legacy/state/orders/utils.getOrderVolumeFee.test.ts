import { getOrderVolumeFee } from './utils'

const SAFE = '0x858f0F5eE954846D47155F5203c04aF1819eCeF8'
const HOST = '0x40d5faafb4540fb1f8f0af5b293425d11cd07fb4'

describe('getOrderVolumeFee', () => {
  it('preserves the exact compounded rate of every stacked Volume entry (host fee + Ophis base), ignoring price improvement', () => {
    const fullAppData = JSON.stringify({
      appCode: 'mtpelerin',
      metadata: {
        partnerFee: [
          { volumeBps: 50, recipient: HOST },
          { volumeBps: 1, recipient: SAFE },
          { priceImprovementBps: 8000, maxVolumeBps: 99, recipient: SAFE },
        ],
      },
    })
    expect(getOrderVolumeFee(fullAppData)).toBe(51.005)
  })

  it('reads a single-entry partnerFee like before', () => {
    const fullAppData = JSON.stringify({
      appCode: 'ophis',
      metadata: { partnerFee: { volumeBps: 1, recipient: SAFE } },
    })
    expect(getOrderVolumeFee(fullAppData)).toBe(1)
  })
})
