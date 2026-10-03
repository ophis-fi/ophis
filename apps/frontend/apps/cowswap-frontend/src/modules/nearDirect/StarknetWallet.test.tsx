import { ComponentProps } from 'react'

import { connect } from '@starknet-io/get-starknet'
import { act, fireEvent, render, screen } from '@testing-library/react'

import fixture from './fixtures/starknetDeposit.json'
import { nearTransferSchema } from './nearDirect.schemas'
import { StarknetWallet } from './StarknetWallet.container'

jest.mock('@starknet-io/get-starknet', () => ({ connect: jest.fn() }))
jest.mock('@cowprotocol/ui', () => ({ ButtonSecondary: (props: ComponentProps<'button'>) => <button {...props} /> }))
const mockTransfer = nearTransferSchema.parse(fixture)
const wallet = {
  id: 'braavos',
  name: 'Braavos',
  version: '1',
  icon: '',
  request: jest.fn(),
  on: jest.fn(),
  off: jest.fn(),
}
beforeEach(() => {
  jest.clearAllMocks()
  jest.mocked(connect).mockResolvedValue(wallet)
  wallet.request.mockImplementation(async ({ type }: { type: string }) =>
    type === 'wallet_requestAccounts' ? [mockTransfer.response.quoteRequest.refundTo] : '0x534e5f4d41494e',
  )
})
it('connects, fills the refund address and invalidates connection on account changes', async () => {
  const onConnect = jest.fn()
  render(<StarknetWallet source={mockTransfer.source} onConnect={onConnect} />)
  fireEvent.click(screen.getByRole('button', { name: 'Connect Starknet wallet' }))
  await screen.findByRole('button', { name: 'Disconnect Starknet wallet' })
  expect(onConnect).toHaveBeenCalledWith(mockTransfer.response.quoteRequest.refundTo)
  const callback = wallet.on.mock.calls.find(([event]) => event === 'accountsChanged')?.[1]
  act(() => callback(['0x999']))
  expect(screen.getByRole('button', { name: 'Connect Starknet wallet' })).toBeTruthy()
  expect(wallet.off).toHaveBeenCalledTimes(2)
})

it('handles cancelled connection and hides the connector on other source networks', async () => {
  jest.mocked(connect).mockResolvedValue(null)
  const onConnect = jest.fn()
  const { rerender } = render(<StarknetWallet source={mockTransfer.source} onConnect={onConnect} />)
  fireEvent.click(screen.getByRole('button', { name: 'Connect Starknet wallet' }))
  await screen.findByRole('button', { name: 'Connect Starknet wallet' })
  expect(onConnect).not.toHaveBeenCalled()
  rerender(<StarknetWallet source={mockTransfer.destination} onConnect={onConnect} />)
  expect(screen.queryByRole('button')).toBeNull()
})
