import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'

import { IntentEntry } from './IntentEntry.container'

jest.mock('./IntentLanding', () => ({ IntentLanding: jest.fn(() => <div>Desktop intent search</div>) }))

function SwapDestination(): string {
  return `Swap${useLocation().search}`
}

describe('direct swap entry', () => {
  it.each(['?utm_source=wallet', '?chain=10&inputCurrency=USDC&exactAmount=10', ''])(
    'preserves the entry query %s',
    (search) => {
      render(
        <MemoryRouter initialEntries={['/' + search]}>
          <Routes>
            <Route path="/" element={<IntentEntry />} />
            <Route path="/swap" element={<SwapDestination />} />
          </Routes>
        </MemoryRouter>,
      )
      expect(screen.getByText('Swap' + search)).toBeTruthy()
      expect(screen.queryByText('Desktop intent search')).toBeNull()
    },
  )
})
