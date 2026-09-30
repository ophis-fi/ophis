import { TokenWithLogo } from '@cowprotocol/common-const'
import { BigNumber } from '@ethersproject/bignumber'

import { render, screen } from '@testing-library/react'

import { TokenListItem } from './index'

jest.mock('./styled', () => ({ TokenItem: 'div', TokenBalance: 'div' }))
jest.mock('../TokenInfo', () => ({ TokenInfo: () => null }))
jest.mock('../TokenTags', () => ({ TokenTags: () => null }))
jest.mock('../../hooks/useDeferredVisibility', () => ({
  useDeferredVisibility: () => ({ ref: null, isVisible: true }),
}))
jest.mock('@cowprotocol/common-utils', () => ({
  isSupportedChainId: () => true,
}))
jest.mock('@cowprotocol/ui', () => ({
  LoadingRows: 'div',
  LoadingRowSmall: () => <span role="progressbar" />,
  TokenAmount: () => <span>loaded balance</span>,
  FiatAmount: () => null,
}))

it('replaces failed balance loaders with an unavailable indicator, preserves balances, and recovers', () => {
  const props = {
    token: new TokenWithLogo('', 1, '0x3600000000000000000000000000000000000000', 6, 'USDC'),
    balance: undefined,
    isWalletConnected: true,
  }
  const { rerender } = render(<TokenListItem {...props} />)
  expect(screen.getByRole('progressbar')).toBeTruthy()

  rerender(<TokenListItem {...props} balanceError />)
  expect(screen.queryByRole('progressbar')).toBeNull()
  expect(screen.getByTitle('Balance unavailable. Try again shortly.')).toBeTruthy()

  rerender(<TokenListItem {...props} balanceError balance={BigNumber.from(0)} />)
  expect(screen.queryByTitle('Balance unavailable. Try again shortly.')).toBeNull()
  expect(screen.getByText('loaded balance')).toBeTruthy()

  rerender(<TokenListItem {...props} balance={BigNumber.from(1000000)} />)
  expect(screen.queryByRole('progressbar')).toBeNull()
  expect(screen.getByText('loaded balance')).toBeTruthy()
})
