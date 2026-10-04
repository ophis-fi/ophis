import { SupportedChainId } from '@cowprotocol/cow-sdk'
import { baseTheme } from '@cowprotocol/ui'

import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { render, screen } from '@testing-library/react'
import { ThemeProvider } from 'styled-components/macro'
import { isAddress as mockIsAddress } from 'viem'

import { AddressInputPanel } from './index'

const mockAddress = '0x1234567890123456789012345678901234567890'
jest.mock('@cowprotocol/wallet', () => ({ useWalletInfo: () => ({ chainId: 8453 }) }))
jest.mock('../../hooks/useOphisNameResolution', () => ({
  useOphisNameResolution: (value: string | null, chainId: number) => ({
    address: value && mockIsAddress(value) ? value : chainId === 1 && value === 'custodes.eth' ? mockAddress : null,
    loading: false,
    integrityError: false,
  }),
}))

const theme = baseTheme('light')

it('explains an unsupported Base name and clears the error when a wallet address is entered', () => {
  const onChange = jest.fn()
  const view = (value: string, chainId = SupportedChainId.BASE): JSX.Element => (
    <I18nProvider i18n={i18n}>
      <ThemeProvider theme={theme}>
        <AddressInputPanel value={value} onChange={onChange} targetChainId={chainId} />
      </ThemeProvider>
    </I18nProvider>
  )
  const { rerender } = render(view('custodes.eth'))
  expect(screen.getByRole('textbox').getAttribute('aria-invalid')).toBe('true')
  expect(screen.getByRole('alert').textContent).toContain('Paste your wallet address on the selected network')
  expect(screen.getByRole('textbox').getAttribute('placeholder')).not.toMatch(/ENS/)

  rerender(view(mockAddress))
  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.getByRole('textbox').getAttribute('aria-invalid')).toBe('false')

  rerender(view('custodes.eth', SupportedChainId.MAINNET))
  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.getByRole('textbox').getAttribute('placeholder')).toMatch(/ENS/)
})
