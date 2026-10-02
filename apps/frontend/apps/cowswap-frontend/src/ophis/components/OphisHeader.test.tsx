import * as commonConst from '@cowprotocol/common-const'
import { useFeatureFlags } from '@cowprotocol/common-hooks'

import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'

import { OphisHeader } from './OphisHeader'

jest.mock('@cowprotocol/common-const', () => ({ __esModule: true, ARC_CHAIN_ID: 5042, ARC_ENABLED: true }))

jest.mock('@cowprotocol/common-hooks', () => ({
  useFeatureFlags: jest.fn(),
}))

jest.mock('modules/trade', () => ({
  useTradeRouteContext: () => ({ chainId: '1', inputCurrencyId: 'WETH' }),
  useDerivedTradeState: () => ({
    inputCurrency: { chainId: 1, address: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2' },
  }),
}))

jest.mock('common/constants/featureFlags', () => ({ CCTP_ENABLED: true }))

jest.mock('../hooks/useScrollClass', () => ({
  useScrollClass: () => false,
}))

const useFeatureFlagsMock = useFeatureFlags as jest.MockedFunction<typeof useFeatureFlags>

function renderHeader(transparent = false, route = '/'): void {
  render(
    <MemoryRouter initialEntries={[route]}>
      <OphisHeader transparent={transparent}>
        <span>Header action</span>
      </OphisHeader>
    </MemoryRouter>,
  )
}

describe('OphisHeader', () => {
  it('announces Arc with its logo and trading link when enabled', () => {
    useFeatureFlagsMock.mockReturnValue({ isOtcEnabled: true })
    renderHeader()
    const banner = screen.getByRole('link', { name: 'Arc is live on Ophis. Trade now' })
    expect(banner.getAttribute('href')).toBe('/#/5042/swap')
    expect(banner.querySelector('img')?.getAttribute('src')).toBe('/logos/chain-arc-network.svg')
  })

  it('hides the Arc announcement when Arc is disabled', () => {
    useFeatureFlagsMock.mockReturnValue({ isOtcEnabled: true })
    const flag = jest.replaceProperty(commonConst, 'ARC_ENABLED', false)
    try {
      renderHeader()
      expect(screen.queryByRole('link', { name: 'Arc is live on Ophis. Trade now' })).toBeNull()
    } finally {
      flag.restore()
    }
  })

  it('keeps the transparent hero wordmark visible with the default light theme', () => {
    useFeatureFlagsMock.mockReturnValue({ isOtcEnabled: true })
    renderHeader(true)
    const wordmark = screen.getByRole('link', { name: 'Ophis, home' })
    const mark = wordmark.querySelector('img')
    if (!mark) throw new Error('Missing header mark')
    expect(getComputedStyle(wordmark).color).toBe('rgb(244, 244, 245)')
    expect(getComputedStyle(mark).filter).toBe('brightness(0) invert(1)')
    expect(getComputedStyle(screen.getByRole('link', { name: 'Open OTC' })).color).toBe('rgb(244, 244, 245)')
  })

  it('links to the OTC surface when Milestone B is enabled', () => {
    useFeatureFlagsMock.mockReturnValue({ isOtcEnabled: true })

    renderHeader()

    expect(screen.getByRole('link', { name: 'Open OTC' }).getAttribute('href')).toBe('/otc')
  })

  it('hides the OTC link when the deployment kill switch is disabled', () => {
    useFeatureFlagsMock.mockReturnValue({ isOtcEnabled: false })

    renderHeader()

    expect(screen.queryByRole('link', { name: 'Open OTC' })).toBeNull()
  })
})

it('omits the OTC self-link on OTC list and order-detail routes', () => {
  useFeatureFlagsMock.mockReturnValue({ isOtcEnabled: true })
  renderHeader(false, '/otc/49')
  expect(screen.queryByRole('link', { name: 'Open OTC' })).toBeNull()
})

it('keeps bridging in the swap box without a separate navigation link', () => {
  useFeatureFlagsMock.mockReturnValue({ isOtcEnabled: true })
  renderHeader(false, '/1/swap/WETH')
  expect(screen.queryByRole('link', { name: 'Bridge' })).toBeNull()
})
