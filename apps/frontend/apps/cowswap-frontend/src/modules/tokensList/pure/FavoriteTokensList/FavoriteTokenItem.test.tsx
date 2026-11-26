import { TokenWithLogo } from '@cowprotocol/common-const'

import { render, screen } from '@testing-library/react'

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
  expect(screen.getByRole('img', { name: 'Verified asset · xStocks' })).toBeTruthy()
  verifyAsset.mockReturnValue(undefined)
  rerender(<FavoriteTokenItem token={token} selectTokenContext={{ verifyAsset }} />)
  expect(screen.queryByRole('img', { name: /Verified asset/ })).toBeNull()
})
