import { act, renderHook } from '@testing-library/react'

import { quoteCctp, readCctpFunds, type CctpQuote } from './cctp.service'
import { useCctpQuote, type RunCctpAction } from './useCctpQuote'

jest.mock('./cctp.service', () => ({ quoteCctp: jest.fn(), readCctpFunds: jest.fn(), isCctpOwner: (owner: string, account: string) => owner === account }))
jest.mock('./cctpWallet.service', () => ({ approveCctp: jest.fn() }))

const owner = '0x0000000000000000000000000000000000000001'
const run: RunCctpAction = async (_label, action) => { await action(() => undefined) }

it('discards a delayed quote after form/account edits and does not revive it when changing back', async () => {
  const resolvers: Array<(quote: CctpQuote) => void> = []
  jest.mocked(quoteCctp).mockImplementation(() => new Promise((resolve) => resolvers.push(resolve)))
  jest.mocked(readCctpFunds).mockResolvedValue({ balance: 100n, allowance: 100n })
  const { result, rerender } = renderHook(({ key }) => useCctpQuote(owner, undefined, run, key), { initialProps: { key: 'old-route' } })
  let pending: Promise<void> | undefined
  act(() => { pending = result.current.loadQuote(1, 5042, '1', 'cirBTC') })
  rerender({ key: 'new-route' })
  await act(async () => {
    resolvers[0]({ owner, source: 1, destination: 5042, amount: '1' } as CctpQuote)
    await pending
  })
  expect(result.current.quote).toBeNull()
  rerender({ key: 'old-route' })
  expect(result.current.quote).toBeNull()
})

it.each(['edit', 'unmount'])('invalidates a captured signature guard on %s', async (change) => {
  jest.mocked(quoteCctp).mockResolvedValue({ owner, source: 1, destination: 5042, amount: '1' } as CctpQuote)
  jest.mocked(readCctpFunds).mockResolvedValue({ balance: 100n, allowance: 100n })
  const { result, rerender, unmount } = renderHook(({ key }) => useCctpQuote(owner, undefined, run, key), { initialProps: { key: 'reviewed' } })
  await act(async () => { await result.current.loadQuote(1, 5042, '1', 'cirBTC') })
  const guard = result.current.assertCurrentQuote
  expect(guard).not.toThrow()
  if (change === 'unmount') unmount()
  else rerender({ key: 'edited' })
  expect(guard).toThrow('changed')
})
