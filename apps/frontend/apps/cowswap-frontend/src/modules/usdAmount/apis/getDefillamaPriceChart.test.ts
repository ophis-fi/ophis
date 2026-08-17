import { parseDefillamaPriceChart } from './getDefillamaPriceChart'

/**
 * Captured from the live API on 2026-07-30 so the parser is pinned to a real
 * body rather than to my idea of one:
 *   GET https://coins.llama.fi/chart/optimism:0x4200…0006?span=7&period=1d
 */
const LIVE_BODY = {
  coins: {
    'optimism:0x4200000000000000000000000000000000000006': {
      symbol: 'WETH',
      confidence: 0.99,
      decimals: 18,
      prices: [
        { timestamp: 1784926383, price: 1857.0281 },
        { timestamp: 1785012783, price: 1871.4412 },
        { timestamp: 1785099183, price: 1919.1181 },
      ],
    },
  },
}

describe('parseDefillamaPriceChart', () => {
  it('parses a real captured response', () => {
    expect(parseDefillamaPriceChart(LIVE_BODY)).toEqual([
      { time: 1784926383, value: 1857.0281 },
      { time: 1785012783, value: 1871.4412 },
      { time: 1785099183, value: 1919.1181 },
    ])
  })

  it('returns [] for an unlisted token instead of throwing', () => {
    // The API answers HTTP 200 with an empty coins map, not an error status.
    expect(parseDefillamaPriceChart({ coins: {} })).toEqual([])
  })

  it('is total: every malformed shape yields [] rather than throwing', () => {
    const malformed: unknown[] = [
      null,
      undefined,
      'a string',
      42,
      [],
      {},
      { coins: null },
      { coins: 'nope' },
      { coins: [] },
      { coins: { k: null } },
      { coins: { k: {} } },
      { coins: { k: { prices: null } } },
      { coins: { k: { prices: 'nope' } } },
      { coins: { k: { prices: {} } } },
    ]

    for (const body of malformed) {
      expect(() => parseDefillamaPriceChart(body)).not.toThrow()
      expect(parseDefillamaPriceChart(body)).toEqual([])
    }
  })

  it('drops individual bad points without losing the good ones', () => {
    const result = parseDefillamaPriceChart({
      coins: {
        k: {
          prices: [
            { timestamp: 100, price: 10 },
            null,
            'garbage',
            { timestamp: 'not-a-number', price: 11 },
            { timestamp: 200, price: 'not-a-number' },
            { timestamp: 300, price: Number.NaN },
            { timestamp: Number.POSITIVE_INFINITY, price: 12 },
            { timestamp: 400, price: 13 },
          ],
        },
      },
    })

    expect(result).toEqual([
      { time: 100, value: 10 },
      { time: 400, value: 13 },
    ])
  })

  it('drops non-positive prices, which would flatten the series scale', () => {
    expect(
      parseDefillamaPriceChart({
        coins: {
          k: {
            prices: [
              { timestamp: 1, price: 0 },
              { timestamp: 2, price: -5 },
              { timestamp: 3, price: 7 },
            ],
          },
        },
      }),
    ).toEqual([{ time: 3, value: 7 }])
  })

  it('sorts ascending, because lightweight-charts throws on unsorted times', () => {
    const result = parseDefillamaPriceChart({
      coins: {
        k: {
          prices: [
            { timestamp: 300, price: 3 },
            { timestamp: 100, price: 1 },
            { timestamp: 200, price: 2 },
          ],
        },
      },
    })

    expect(result.map((p) => p.time)).toEqual([100, 200, 300])
  })

  it('de-duplicates identical timestamps, which lightweight-charts also rejects', () => {
    const result = parseDefillamaPriceChart({
      coins: {
        k: {
          prices: [
            { timestamp: 100, price: 1 },
            { timestamp: 100, price: 2 },
            { timestamp: 200, price: 3 },
          ],
        },
      },
    })

    expect(result).toEqual([
      { time: 100, value: 1 },
      { time: 200, value: 3 },
    ])
  })

  it('floors fractional timestamps to whole seconds', () => {
    expect(parseDefillamaPriceChart({ coins: { k: { prices: [{ timestamp: 100.9, price: 1 }] } } })).toEqual([
      { time: 100, value: 1 },
    ])
  })

  it('reads the first coin entry rather than re-deriving the key', () => {
    // The API echoes the requested key back. Re-deriving it in the parser would
    // mean a casing or slug mismatch silently produces an empty chart.
    expect(
      parseDefillamaPriceChart({
        coins: { 'SOME-UNEXPECTED:0xAbC': { prices: [{ timestamp: 1, price: 9 }] } },
      }),
    ).toEqual([{ time: 1, value: 9 }])
  })
})
