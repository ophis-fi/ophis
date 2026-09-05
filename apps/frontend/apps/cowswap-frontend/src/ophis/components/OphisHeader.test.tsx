import { useFeatureFlags } from '@cowprotocol/common-hooks'

import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'

import { OphisHeader } from './OphisHeader'

jest.mock('@cowprotocol/common-hooks', () => ({
  useFeatureFlags: jest.fn(),
}))

jest.mock('../hooks/useScrollClass', () => ({
  useScrollClass: () => false,
}))

const useFeatureFlagsMock = useFeatureFlags as jest.MockedFunction<typeof useFeatureFlags>

function renderHeader(): void {
  render(
    <MemoryRouter>
      <OphisHeader>
        <span>Header action</span>
      </OphisHeader>
    </MemoryRouter>,
  )
}

describe('OphisHeader', () => {
  it('links to the OTC surface when Milestone B is enabled', () => {
    useFeatureFlagsMock.mockReturnValue({ isOtcEnabled: true })

    renderHeader()

    expect(screen.getByRole('link', { name: 'OTC' }).getAttribute('href')).toBe('/otc')
  })

  it('hides the OTC link when the deployment kill switch is disabled', () => {
    useFeatureFlagsMock.mockReturnValue({ isOtcEnabled: false })

    renderHeader()

    expect(screen.queryByRole('link', { name: 'OTC' })).toBeNull()
  })
})
