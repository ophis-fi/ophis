import { TokenWithLogo } from '@cowprotocol/common-const'

import { render, screen, within } from '@testing-library/react'

import { CurrencySelectButtonContainer } from './CurrencySelectButton.container'

jest.mock('entities/bridgeProvider', () => ({ useBridgeSupportedNetwork: () => undefined }))
jest.mock('@cowprotocol/tokens', () => ({ TokenLogo: () => null }))

it('shows the Arbitrum issuer on selection and removes the badge for a same-symbol contract', async () => {
  const symbol = 'NVDAx'
  const currency = new TokenWithLogo(undefined, 42161, '0xc845b2894dbddd03858fd2d643b4ef725fe0849d', 18, symbol)
  const { rerender } = render(<CurrencySelectButtonContainer currency={currency} loading={false} readonlyMode />)
  const selected = within(screen.getByRole('button', { name: /Selected token: NVDAx/ }))
  expect(await selected.findByRole('img', { name: 'Verified asset · xStocks' })).toBeTruthy()
  const other = new TokenWithLogo(undefined, 42161, '0x0000000000000000000000000000000000000001', 18, symbol)
  rerender(<CurrencySelectButtonContainer currency={other} loading={false} readonlyMode />)
  expect(selected.queryByRole('img', { name: /Verified asset/ })).toBeNull()
})
