import type { ReactElement } from 'react'

import { CurrencyAmount, Token } from '@cowprotocol/currency'

import { setupI18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { fireEvent, render, screen } from '@testing-library/react'
import { ThemeProvider } from 'styled-components/macro'
import { getCowswapTheme } from 'theme/getCowswapTheme'

import { Field } from 'legacy/state/types'

import { CurrencyInputPanel, CurrencyInputPanelProps } from './CurrencyInputPanel'

jest.mock('modules/usdAmount', () => ({ useUsdAmount: () => ({ value: null }) }))
jest.mock('common/hooks/useConvertUsdToTokenValue', () => ({
  useConvertUsdToTokenValue: () => (value: string) => value,
}))
jest.mock('common/containers/CurrencySelectButton.container', () => ({ CurrencySelectButtonContainer: () => null }))
jest.mock('common/pure/FiatValue', () => ({ FiatValue: () => null }))
jest.mock('../ReceiveAmount', () => ({ ReceiveAmount: () => null }))

it('sizes a new sell even from an exact-buy quote, with wallet precision and read-only states', () => {
  const token = new Token(1, '0x1111111111111111111111111111111111111111', 0, 'SHARE')
  const maxBalance = CurrencyAmount.fromRawAmount(token, '9007199254740995')
  const onUserInput = jest.fn()
  const props: CurrencyInputPanelProps = {
    id: 'input-currency-input',
    chainId: 1,
    areCurrenciesLoading: false,
    bothCurrenciesSet: true,
    isProviderNetworkUnsupported: false,
    isProviderNetworkDeprecated: false,
    allowsOffchainSigning: true,
    currencyInfo: {
      field: Field.INPUT,
      currency: token,
      balance: maxBalance,
      amount: null,
      isIndependent: false,
      receiveAmountInfo: null,
      fiatAmount: null,
    },
    onCurrencySelection: jest.fn(),
    openTokenSelectWidget: jest.fn(),
    onUserInput,
    showSetMax: true,
    maxBalance,
  }
  const wrap = (overrides: Partial<CurrencyInputPanelProps>): ReactElement => (
    <I18nProvider i18n={setupI18n({ locale: 'en', messages: { en: {} } })}>
      <ThemeProvider theme={getCowswapTheme(false)}>
        <CurrencyInputPanel {...props} {...overrides} />
      </ThemeProvider>
    </I18nProvider>
  )
  const { rerender } = render(wrap({}))
  for (const [name, amount] of [
    ['25%', '2251799813685248'],
    ['50%', '4503599627370497'],
    ['Max', '9007199254740995'],
  ]) {
    fireEvent.click(screen.getByRole('button', { name }))
    expect(onUserInput).toHaveBeenLastCalledWith(Field.INPUT, amount)
  }
  rerender(wrap({ maxBalance: CurrencyAmount.fromRawAmount(token, 1) }))
  expect(screen.getByRole('button', { name: '25%' }).hasAttribute('disabled')).toBe(true)
  expect(screen.getByRole('button', { name: 'Max' }).hasAttribute('disabled')).toBe(false)
  rerender(wrap({ maxBalance: undefined }))
  expect(screen.getByRole('button', { name: 'Max' }).hasAttribute('disabled')).toBe(true)
  rerender(wrap({ inputDisabled: true }))
  expect(screen.getByRole('button', { name: 'Max' }).hasAttribute('disabled')).toBe(true)
  rerender(wrap({ showSetMax: false, currencyInfo: { ...props.currencyInfo, field: Field.OUTPUT } }))
  expect(screen.queryByRole('button', { name: 'Max' })).toBeNull()
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '7' } })
  expect(onUserInput).toHaveBeenLastCalledWith(Field.OUTPUT, '7')
})
