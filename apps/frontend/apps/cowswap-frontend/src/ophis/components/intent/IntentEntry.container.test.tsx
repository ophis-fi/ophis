import { useMediaQuery } from '@cowprotocol/common-hooks'

import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'

import { IntentEntry } from './IntentEntry.container'

jest.mock('@cowprotocol/common-hooks', () => ({ useMediaQuery: jest.fn() }))
jest.mock('./IntentLanding', () => ({ IntentLanding: jest.fn(() => <div>Desktop intent search</div>) }))

function SwapDestination(): string {
  return `Swap${useLocation().search}`
}

describe('mobile swap entry', () => {
  it.each([true, false])('routes directly to swap only on phones (%s)', (isPhone) => {
    jest.mocked(useMediaQuery).mockReturnValue(isPhone)
    render(
      <MemoryRouter initialEntries={['/?utm_source=wallet']}>
        <Routes>
          <Route path="/" element={<IntentEntry />} />
          <Route path="/swap" element={<SwapDestination />} />
        </Routes>
      </MemoryRouter>,
    )
    expect(screen.getByText(isPhone ? 'Swap?utm_source=wallet' : 'Desktop intent search')).toBeTruthy()
    if (isPhone) expect(screen.queryByText('Desktop intent search')).toBeNull()
  })
})
