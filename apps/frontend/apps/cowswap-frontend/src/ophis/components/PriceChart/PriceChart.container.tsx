/**
 * Price chart for the swap page side rail.
 *
 * Charts the token the user is BUYING, falling back to the sell token, because
 * the buy side is what someone is deciding about. Data is DefiLlama's free price
 * history, called browser-direct and shared with the spot-price client's rate
 * limiter.
 *
 * Renders nothing when there is no series: no chain, no token, a chain DefiLlama
 * does not list (Robinhood 4663 and MegaETH 4326 are explicitly `null` in
 * DEFILLAMA_PLATFORMS), or a token it has no history for. An empty shell would
 * imply the data is loading forever.
 *
 * Chart library is lightweight-charts, Apache-2.0, already a dependency of the
 * explorer app and pinned to the same `^3.3.0` range so pnpm keeps ONE copy.
 * Do not move to ^4 or ^5 without porting the explorer too: v4 renamed
 * `layout.backgroundColor`, v5 replaced `addAreaSeries()` with `addSeries()`.
 */
import { ReactNode, useEffect, useMemo, useRef, useState } from 'react'

import { useWalletInfo } from '@cowprotocol/wallet'

import { createChart, IChartApi, UTCTimestamp } from 'lightweight-charts'
import { useTheme } from 'styled-components/macro'

import { useDerivedTradeState } from 'modules/trade'
import { PriceChartRange } from 'modules/usdAmount'

import * as styledEl from './PriceChart.styled'
import { usePriceChartData } from './usePriceChartData'

const RANGES: readonly PriceChartRange[] = ['1D', '7D', '1M', '1Y']

const CHART_HEIGHT = 120

export function PriceChart(): ReactNode {
  const { chainId } = useWalletInfo()
  const tradeState = useDerivedTradeState()
  const [range, setRange] = useState<PriceChartRange>('1M')
  const hostRef = useRef<HTMLDivElement | null>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const theme = useTheme()
  // Optional access: the chart must not be the thing that throws if a surface
  // ever renders it outside a ThemeProvider.
  const textColor = theme?.text1 ?? '#ffffff'

  // The buy side is what the user is deciding about; fall back to the sell side
  // so the panel still has something to show before an output token is picked.
  const currency = tradeState?.outputCurrency ?? tradeState?.inputCurrency
  const tokenAddress = currency && 'address' in currency ? currency.address : undefined

  const { points, isLoading } = usePriceChartData(chainId, tokenAddress, range)

  const seriesData = useMemo(
    () => points.map((point) => ({ time: point.time as UTCTimestamp, value: point.value })),
    [points],
  )

  useEffect(() => {
    const host = hostRef.current
    if (!host || seriesData.length === 0) return

    const chart = createChart(host, {
      width: host.clientWidth,
      height: CHART_HEIGHT,
      layout: { backgroundColor: 'transparent', textColor, fontSize: 10 },
      grid: { vertLines: { visible: false }, horzLines: { visible: false } },
      rightPriceScale: { visible: false },
      timeScale: { visible: false, fixLeftEdge: true, fixRightEdge: true },
      crosshair: { horzLine: { visible: false }, vertLine: { visible: false } },
      handleScroll: false,
      handleScale: false,
    })
    chartRef.current = chart

    chart
      .addAreaSeries({
        lineColor: '#6dcfa1',
        topColor: 'rgba(109, 207, 161, 0.28)',
        bottomColor: 'rgba(109, 207, 161, 0.02)',
        lineWidth: 2,
        priceLineVisible: false,
        lastValueVisible: false,
      })
      .setData([...seriesData])

    chart.timeScale().fitContent()

    // The explorer's chart omits this and leaks a chart per remount. The rail
    // remounts on every chain and token change, so cleaning up is not optional.
    const resize = (): void => chart.applyOptions({ width: host.clientWidth })
    window.addEventListener('resize', resize)

    return () => {
      window.removeEventListener('resize', resize)
      chart.remove()
      chartRef.current = null
    }
  }, [seriesData, textColor])

  // No series means no panel. Keep the shell only while the first fetch is in
  // flight, so a supported token does not flicker in and out of the rail.
  if (seriesData.length === 0 && !isLoading) return null

  const latest = points[points.length - 1]?.value

  return (
    <styledEl.Panel aria-labelledby="ophis-price-chart-title">
      <styledEl.Head>
        <styledEl.Symbol id="ophis-price-chart-title">{currency?.symbol ?? ''}</styledEl.Symbol>
        {latest !== undefined && (
          <styledEl.Price>
            {latest.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 })}
          </styledEl.Price>
        )}
        <styledEl.Ranges role="group" aria-label="Chart range">
          {RANGES.map((option) => (
            <styledEl.RangeButton
              key={option}
              type="button"
              active={option === range}
              aria-pressed={option === range}
              onClick={() => setRange(option)}
            >
              {option}
            </styledEl.RangeButton>
          ))}
        </styledEl.Ranges>
      </styledEl.Head>

      {seriesData.length === 0 ? <styledEl.Placeholder /> : <styledEl.ChartHost ref={hostRef} />}
    </styledEl.Panel>
  )
}
