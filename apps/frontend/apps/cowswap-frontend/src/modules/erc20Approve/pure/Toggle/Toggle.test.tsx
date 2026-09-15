import { CurrencyAmount, Token } from '@cowprotocol/currency'

import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { fireEvent, render, screen } from '@testing-library/react'
import { mobileSwapTheme } from 'ophis/mobile/mobileSwapTheme.constants'
import { ThemeProvider } from 'styled-components/macro'

import { Toggle } from './Toggle'

jest.mock('react-inlinesvg', () => () => null)

const token = new Token(1, '0x1234567890123456789012345678901234567890', 18, 'USDC')

it('displays the full cap, keeps editing available, and labels unlimited approval honestly', () => {
  const edit = jest.fn()
  const select = jest.fn()
  const amount = CurrencyAmount.fromRawAmount(token, '10000000000000000001')
  const view = (partial: boolean): React.ReactElement => (
    <I18nProvider i18n={i18n}>
      <ThemeProvider theme={mobileSwapTheme}>
        <Toggle
          amountToApprove={amount}
          isPartialApproveSelected={partial}
          selectPartialApprove={select}
          changeApproveAmount={edit}
        />
      </ThemeProvider>
    </I18nProvider>
  )
  const { rerender } = render(view(true))
  expect(screen.getByTestId('spending-limit-amount').textContent).toBe('10.000000000000000001 USDC')
  fireEvent.click(screen.getByRole('button', { name: 'Edit limit' }))
  expect(edit).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByText('Approval options'))
  fireEvent.click(screen.getByRole('button', { name: /Full approval/ }))
  expect(select).toHaveBeenCalledWith(false)
  rerender(view(false))
  expect(screen.getByTestId('spending-limit-amount').textContent).toBe('Unlimited')
  expect(screen.queryByText('Only this amount will be approved.')).toBeNull()
  expect(screen.queryByRole('button', { name: 'Edit limit' })).toBeNull()
})
