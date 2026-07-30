import { getAddressKey, SupportedChainId } from '@cowprotocol/cow-sdk'

import { defillamaFetchRateLimited, DEFILLAMA_PLATFORMS } from './getDefillamaUsdPrice'

/**
 * Historical USD price series from DefiLlama.
 *
 * Browser-direct on purpose. A Cloudflare Pages Function proxy is the obvious
 * shape for a keyless API, and it is known-broken for this class of endpoint:
 * see the note at `ophis/hooks/geckoTerminal.ts`, where the same idea was
 * reverted because CF's shared egress IPs get throttled by these free APIs.
 *
 * Shares `defillamaFetchRateLimited` with the spot-price client so the 2 req/s
 * budget and the 429 cool-off are one budget, not two against the same host.
 *
 * Response shape, verified live 2026-07-30:
 *   { coins: { "optimism:0x4200…0006": { symbol, confidence, decimals,
 *              prices: [ { timestamp: <unix SECONDS>, price: <number> } ] } } }
 * An unknown token is not an error: the API returns `{"coins":{}}` with HTTP 200.
 */

const CHART_BASE_URL = 'https://coins.llama.fi/chart'

export type PriceChartRange = '1D' | '7D' | '1M' | '1Y'

/**
 * span/period per range, each verified against the live API:
 *   1D -> 24 hourly points, 7D -> 7 daily, 1M -> 30 daily, 1Y -> 365 daily.
 */
const RANGE_QUERY: Record<PriceChartRange, { span: number; period: string }> = {
  '1D': { span: 24, period: '1h' },
  '7D': { span: 7, period: '1d' },
  '1M': { span: 30, period: '1d' },
  '1Y': { span: 365, period: '1d' },
}

export interface PricePoint {
  /** Unix SECONDS. lightweight-charts' UTCTimestamp is seconds, not millis. */
  readonly time: number
  readonly value: number
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/**
 * Parse the chart body into points, total: any malformed shape yields `[]`
 * rather than throwing. Follows `parseTrending` in `ophis/hooks/geckoTerminal.ts`.
 *
 * Exported for tests. A price feed is third-party data reaching a render path,
 * so every field is checked rather than trusted.
 */
export function parseDefillamaPriceChart(body: unknown): PricePoint[] {
  if (typeof body !== 'object' || body === null) return []

  const coins = (body as { coins?: unknown }).coins
  if (typeof coins !== 'object' || coins === null) return []

  // One key was requested, but read the first entry rather than re-deriving the
  // key: the API echoes it back and a casing mismatch would silently yield [].
  const firstCoin = Object.values(coins as Record<string, unknown>)[0]
  if (typeof firstCoin !== 'object' || firstCoin === null) return []

  const prices = (firstCoin as { prices?: unknown }).prices
  if (!Array.isArray(prices)) return []

  const points = prices.reduce<PricePoint[]>((acc, entry) => {
    if (typeof entry !== 'object' || entry === null) return acc

    const { timestamp, price } = entry as { timestamp?: unknown; price?: unknown }
    // Drop non-positive prices too: a zero would flatten the whole series scale.
    if (!isFiniteNumber(timestamp) || !isFiniteNumber(price) || price <= 0) return acc

    acc.push({ time: Math.floor(timestamp), value: price })
    return acc
  }, [])

  // lightweight-charts THROWS on unsorted or duplicate times. The API returns
  // ascending today; sorting and de-duplicating here means a change on their
  // side degrades the chart instead of crashing the panel.
  points.sort((a, b) => a.time - b.time)

  return points.filter((point, index) => index === 0 || point.time !== points[index - 1].time)
}

/**
 * Fetch a token's USD price history, or `[]` when unavailable.
 *
 * Never throws. Chains DefiLlama does not list (Robinhood 4663, MegaETH 4326)
 * map to `null` in DEFILLAMA_PLATFORMS and short-circuit without a request.
 */
export async function getDefillamaPriceChart(
  chainId: SupportedChainId,
  tokenAddress: string,
  range: PriceChartRange,
  signal?: AbortSignal,
): Promise<PricePoint[]> {
  const platform = DEFILLAMA_PLATFORMS[chainId]
  if (!platform) return []

  const { span, period } = RANGE_QUERY[range]
  const key = `${platform}:${getAddressKey(tokenAddress)}`
  const url = `${CHART_BASE_URL}/${key}?span=${span}&period=${period}`

  try {
    const response = await defillamaFetchRateLimited(url, { signal })
    if (!response.ok) return []

    return parseDefillamaPriceChart(await response.json())
  } catch {
    // Includes the abort on unmount or range change. A price chart is
    // decoration: it must never surface an error into the swap page.
    return []
  }
}
