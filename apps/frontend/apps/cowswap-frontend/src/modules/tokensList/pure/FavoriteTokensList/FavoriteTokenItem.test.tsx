import { TokenWithLogo } from '@cowprotocol/common-const'

import { render, screen } from '@testing-library/react'
import { presetVerification } from 'entities/verifiedAsset/verifiedAsset'

import { FavoriteTokenItem } from './FavoriteTokenItem'

import type { SelectTokenContext } from '../../types'

jest.mock('@cowprotocol/tokens', () => ({ TokenLogo: () => null }))
jest.mock('../../hooks/useSelectTokenWidgetState', () => ({ useSelectTokenWidgetState: () => ({}) }))

it('shows the verified issuer passed to a favorite or recent token chip', () => {
  const token = new TokenWithLogo(undefined, 42161, '0xc845b2894dbddd03858fd2d643b4ef725fe0849d', 18, 'NVDAx')
  const verifyAsset: jest.MockedFunction<SelectTokenContext['verifyAsset']> = jest.fn()
  verifyAsset.mockReturnValue('xStocks')
  const { rerender } = render(<FavoriteTokenItem token={token} selectTokenContext={{ verifyAsset }} />)
  expect(verifyAsset).toHaveBeenCalledWith(token)
  expect(screen.getByText('xStocks')).toBeTruthy()
  expect(screen.queryByRole('img')).toBeNull()
  verifyAsset.mockReturnValue(undefined)
  rerender(<FavoriteTokenItem token={token} selectTokenContext={{ verifyAsset }} />)
  expect(screen.queryByText('xStocks')).toBeNull()
})

it.each([
  ['0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d', 'USDC'],
  ['0x55d398326f99059ff775485246999027b3197955', 'USDT'],
])('omits the watermark on Binance-Peg %s', (address, symbol) => {
  const token = new TokenWithLogo(undefined, 56, address, 18, symbol)
  render(<FavoriteTokenItem token={token} selectTokenContext={{ verifyAsset: presetVerification }} />)
  expect(screen.getByText(symbol)).toBeTruthy()
  expect(screen.queryByRole('img')).toBeNull()
})
