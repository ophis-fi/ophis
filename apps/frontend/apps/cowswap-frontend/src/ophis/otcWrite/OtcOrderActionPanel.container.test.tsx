import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { readOtcOrder } from 'ophis/otc'

import { OtcOrderActionPanel } from './OtcOrderActionPanel.container'
import { mockOtcOrder, mockOtcWriteClient, TX_HASH } from './prepareOtcTransactionTest.utils'
import { useOtcNetworkReads } from './useOtcNetworkReads'

jest.mock('@cowprotocol/wallet', () => ({
  useWalletInfo: () => ({ account: '0x1111111111111111111111111111111111111111', chainId: 1 }),
}))
jest.mock('wagmi', () => ({ useWalletClient: () => ({}) }))
jest.mock('ophis/otc', () => ({ ...jest.requireActual('ophis/otc'), readOtcOrder: jest.fn() }))
jest.mock('./useOtcNetworkReads', () => ({ useOtcNetworkReads: jest.fn() }))
jest.mock('./OtcActionControl.container', () => {
  const { useState } = jest.requireActual<typeof import('react')>('react')
  return {
    OtcActionControl: ({ definition }: { definition: { reviewed: boolean } }) => {
      const [pending, setPending] = useState(false)
      return (
        <button disabled={pending || !definition.reviewed} onClick={() => setPending(true)}>
          {pending ? 'Waiting for receipt' : 'Submit reviewed order'}
        </button>
      )
    },
  }
})
jest.mock('./useOtcUsdAmount', () => ({ useOtcUsdAmount: () => ({ value: null, isLoading: false }) }))

const read = jest.mocked(readOtcOrder)

beforeEach(() => {
  jest.useFakeTimers()
  read.mockReset().mockRejectedValue(new Error('Ophis OTC order read timed out'))
  jest.mocked(useOtcNetworkReads).mockReturnValue({
    transportId: 1,
    networkResponse: { data: `0x${'aa'.repeat(32)}`, error: null, mutate: jest.fn() },
    writeClient: mockOtcWriteClient(),
    wallet: null,
    allowanceResponse: { data: null, error: null, mutate: jest.fn() },
  })
})

afterEach(() => {
  cleanup()
  jest.useRealTimers()
})

it('shows a failed order read immediately and waits for an explicit retry', async () => {
  render(<OtcOrderActionPanel orderId={7n} />)
  const retry = await screen.findByRole('button', { name: 'Retry order' })
  await act(async () => jest.advanceTimersByTime(20_000))
  expect(read).toHaveBeenCalledTimes(1)
  await act(async () => fireEvent.click(retry))
  expect(read).toHaveBeenCalledTimes(2)
})

it('replaces previously verified terms with recovery when a refresh fails', async () => {
  read.mockResolvedValueOnce({
    order: mockOtcOrder({ orderId: 8n, maker: '0x1111111111111111111111111111111111111111' }),
    blockNumber: 1n,
    blockHash: TX_HASH,
  })
  render(<OtcOrderActionPanel orderId={8n} />)
  await screen.findByText('Cancel order')
  fireEvent.click(screen.getByRole('checkbox'))
  expect(screen.getByRole('button', { name: 'Submit reviewed order' }).hasAttribute('disabled')).toBe(false)
  await act(async () => jest.advanceTimersByTime(5_000))
  await screen.findByRole('button', { name: 'Retry order' })
  expect(screen.queryByText(/Cancellation returns/)).toBeNull()
  expect(screen.getByRole('button', { name: 'Submit reviewed order' }).hasAttribute('disabled')).toBe(true)
  await act(async () => jest.advanceTimersByTime(20_000))
  expect(read).toHaveBeenCalledTimes(2)
})

it('keeps an active action control mounted when a background order read fails', async () => {
  read.mockResolvedValueOnce({
    order: mockOtcOrder({ orderId: 9n, maker: '0x1111111111111111111111111111111111111111' }),
    blockNumber: 1n,
    blockHash: TX_HASH,
  })
  render(<OtcOrderActionPanel orderId={9n} />)
  fireEvent.click(await screen.findByRole('checkbox'))
  fireEvent.click(screen.getByRole('button', { name: 'Submit reviewed order' }))
  await act(async () => jest.advanceTimersByTime(5_000))
  await screen.findByRole('button', { name: /Retry (?:fork )?order/ })
  expect(screen.getByRole('button', { name: 'Waiting for receipt' }).hasAttribute('disabled')).toBe(true)
  expect(screen.queryByText(/Cancellation returns/)).toBeNull()
})
