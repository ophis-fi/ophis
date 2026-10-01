import { NATIVE_CURRENCIES, SUI_CHAIN_ID, TokenWithLogo } from '@cowprotocol/common-const'
import { AdditionalTargetChainId } from '@cowprotocol/cow-sdk'
import { BigNumber } from '@ethersproject/bignumber'

import { fireEvent, render, screen } from '@testing-library/react'

import { TokenListItem } from './index'

jest.mock('./styled', () => ({ TokenItem: 'div', TokenBalance: 'div' }))
jest.mock('../TokenInfo', () => ({ TokenInfo: () => null }))
jest.mock('../TokenTags', () => ({ TokenTags: () => null }))
jest.mock('../../hooks/useDeferredVisibility', () => ({
  useDeferredVisibility: () => ({ ref: null, isVisible: true }),
}))
jest.mock('@cowprotocol/common-utils', () => ({
  ...jest.requireActual('@cowprotocol/common-utils'),
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

it.each([
  [AdditionalTargetChainId.SOLANA, 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', false],
  [SUI_CHAIN_ID, '0x2::coin::USDC', false],
  [SUI_CHAIN_ID, '0x2::sui::SUI', false],
  [1, '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', true],
])('compares selected token identity on chain %s for %s', (chainId, address, sameIdentity) => {
  const token = new TokenWithLogo(undefined, chainId, address, 6, 'TOKEN')
  const selectedToken = new TokenWithLogo(undefined, chainId, address.toLowerCase(), 6, 'TOKEN')
  const onSelectToken = jest.fn()
  const props = { token, selectedToken, onSelectToken, balance: undefined, isWalletConnected: false }
  const { container, rerender } = render(<TokenListItem {...props} />)
  const row = container.querySelector('[data-element-type="token-selection"]')
  if (!row) throw new Error('Token row missing')

  expect(row.classList.contains('token-item-selected')).toBe(sameIdentity)
  fireEvent.click(row)
  expect(onSelectToken).toHaveBeenCalledTimes(sameIdentity ? 0 : 1)

  onSelectToken.mockClear()
  rerender(<TokenListItem {...props} selectedToken={token} />)
  expect(row.classList.contains('token-item-selected')).toBe(true)
  fireEvent.click(row)
  expect(onSelectToken).not.toHaveBeenCalled()
})

it('keeps native EVM currency selection and chain isolation', () => {
  const selectedToken = NATIVE_CURRENCIES[1]
  const token = new TokenWithLogo(undefined, 1, selectedToken.address, selectedToken.decimals, selectedToken.symbol)
  const props = { token, selectedToken, balance: undefined, isWalletConnected: false }
  const { container, rerender } = render(<TokenListItem {...props} />)
  expect(container.querySelector('.token-item-selected')).toBeTruthy()
  rerender(<TokenListItem {...props} token={new TokenWithLogo(undefined, 10, token.address, token.decimals)} />)
  expect(container.querySelector('.token-item-selected')).toBeNull()
})
