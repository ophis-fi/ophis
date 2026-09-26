import { setupI18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { render, screen } from '@testing-library/react'
import { ThemeProvider } from 'styled-components/macro'
import { getCowswapTheme } from 'theme'

import { SolverCompetition } from 'common/types/soverCompetition'

import { SolverRow } from './FinishedStep'

const i18n = setupI18n({ locale: 'en', messages: { en: {} } })

it.each([
  { solver: 'uniswap-v3', displayName: 'Ophis', route: 'Uniswap v3', image: '/ophis-icon.svg' },
  { solver: 'independent', displayName: 'Independent solver', image: 'https://example.com/solver.svg' },
])('renders the operator and optional route for $solver', (solver: SolverCompetition) => {
  render(
    <ThemeProvider theme={getCowswapTheme(false)}>
      <I18nProvider i18n={i18n}>
        <table>
          <tbody>
            <SolverRow solver={solver} index={0} solvers={[solver]} />
          </tbody>
        </table>
      </I18nProvider>
    </ThemeProvider>,
  )

  expect(screen.getByText(solver.displayName || '')).toBeTruthy()
  expect(screen.getByRole('img').getAttribute('src')).toBe(solver.image)
  expect(screen.getByText('Winner')).toBeTruthy()
  if (solver.route) {
    expect(screen.getByText(`via ${solver.route}`).tagName).toBe('SMALL')
  } else {
    expect(screen.queryByText(/^via /)).toBeNull()
  }
})
