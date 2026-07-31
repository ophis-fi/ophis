import React from 'react'

import { useWalletInfo } from '@cowprotocol/wallet'

import { act, render as rtlRender } from '@testing-library/react'
import { ThemeProvider } from 'styled-components/macro'

import { useDerivedTradeState } from 'modules/trade'
import { getDefillamaPriceChart } from 'modules/usdAmount'

import { PriceChart } from './PriceChart.container'

jest.mock('@cowprotocol/wallet', () => ({
  ...jest.requireActual('@cowprotocol/wallet'),
  useWalletInfo: jest.fn(),
}))

// NOT jest.requireActual on these barrels: `modules/trade` transitively pulls in
// TradeWidgetForm -> RobinhoodAssetContext -> data.ts, which does not load under
// jest. Only the two symbols this component uses are needed.
jest.mock('modules/trade', () => ({
  useDerivedTradeState: jest.fn(),
}))

jest.mock('modules/usdAmount', () => ({
  getDefillamaPriceChart: jest.fn(),
}))

// jsdom has no canvas, and lightweight-charts draws into one. The component's
// contract under test is which panel state it chooses, not what it paints, so
// the library is stubbed with a shape that records cleanup.
// `mock`-prefixed so jest's hoisting of jest.mock() above these declarations is
// allowed: the factory may not close over any other out-of-scope variable.
const mockChartRemove = jest.fn()
const mockSetData = jest.fn()
jest.mock('lightweight-charts', () => ({
  createChart: () => ({
    addAreaSeries: () => ({ setData: mockSetData }),
    timeScale: () => ({ fitContent: jest.fn() }),
    applyOptions: jest.fn(),
    remove: mockChartRemove,
  }),
}))

const useWalletInfoMock = useWalletInfo as jest.MockedFunction<typeof useWalletInfo>
const useDerivedTradeStateMock = useDerivedTradeState as jest.MockedFunction<typeof useDerivedTradeState>
const getChartMock = getDefillamaPriceChart as jest.MockedFunction<typeof getDefillamaPriceChart>

// chainId lives on the CURRENCY now: the chart derives it from the token it is
// charting so the two can never disagree during a chain switch.
const WETH = { address: '0x4200000000000000000000000000000000000006', symbol: 'WETH', chainId: 10 }

// The styled panel and the chart's own text colour both read from the theme, so
// render through a provider exactly as the app does.
const THEME = { text1: '#ffffff' }
const render = (ui: React.ReactElement): ReturnType<typeof rtlRender> =>
  rtlRender(<ThemeProvider theme={THEME}>{ui}</ThemeProvider>)

// `currency` takes null, not undefined, for the no-token case: passing undefined
// to a defaulted parameter substitutes the default, which silently made the
// no-token test render WETH and assert against the wrong thing.
function setup(points: { time: number; value: number }[], currency: unknown = WETH): void {
  useWalletInfoMock.mockReturnValue({ chainId: 10, account: undefined } as never)
  useDerivedTradeStateMock.mockReturnValue({ outputCurrency: currency } as never)
  getChartMock.mockResolvedValue(points)
}

describe('PriceChart', () => {
  beforeEach(() => jest.clearAllMocks())

  it('renders nothing once a fetch returns no series', async () => {
    // The empty case is the common one: Robinhood 4663 and MegaETH 4326 are
    // explicitly null in DEFILLAMA_PLATFORMS, and plenty of tokens have no
    // history. An empty shell would imply it is still loading.
    setup([])
    const { container } = render(<PriceChart />)
    await act(async () => undefined)

    expect(container.querySelector('aside')).toBeNull()
  })

  it('renders nothing when there is no token selected', async () => {
    setup([{ time: 1, value: 1 }], null)
    const { container } = render(<PriceChart />)
    await act(async () => undefined)

    expect(container.querySelector('aside')).toBeNull()
    expect(getChartMock).not.toHaveBeenCalled()
  })

  it('renders the panel with the symbol and range controls when data arrives', async () => {
    setup([
      { time: 100, value: 1800 },
      { time: 200, value: 1900 },
    ])
    const { container, getByText, getByRole } = render(<PriceChart />)
    await act(async () => undefined)

    expect(container.querySelector('aside')).not.toBeNull()
    expect(getByText('WETH')).toBeTruthy()
    // Latest point drives the headline price.
    expect(container.textContent).toContain('1,900')
    for (const range of ['1D', '7D', '1M', '1Y']) {
      expect(getByRole('button', { name: range })).toBeTruthy()
    }
  })

  it('defaults to 1M and refetches when another range is picked', async () => {
    setup([{ time: 100, value: 1800 }])
    const { getByRole } = render(<PriceChart />)
    await act(async () => undefined)

    expect(getChartMock).toHaveBeenLastCalledWith(10, WETH.address, '1M', expect.anything())

    await act(async () => {
      getByRole('button', { name: '1Y' }).click()
    })

    expect(getChartMock).toHaveBeenLastCalledWith(10, WETH.address, '1Y', expect.anything())
  })

  it('destroys the chart on unmount, so the rail does not leak one per remount', async () => {
    setup([{ time: 100, value: 1800 }])
    const { unmount } = render(<PriceChart />)
    await act(async () => undefined)

    expect(mockChartRemove).not.toHaveBeenCalled()
    unmount()
    expect(mockChartRemove).toHaveBeenCalled()
  })
})
