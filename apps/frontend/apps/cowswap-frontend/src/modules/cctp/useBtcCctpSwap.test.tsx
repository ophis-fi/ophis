import { createStore, Provider } from 'jotai'
import { type ReactNode } from 'react'

import { act, renderHook } from '@testing-library/react'

import { useQuoteParams } from 'modules/tradeQuote'

import { quoteBtcSwap, type BtcSwapQuote } from './btcSwapQuote.service'
import { readBtcSwapFunds, submitBtcSwap, updateBtcSwap } from './btcSwapSubmission.service'
import { cctpTransferAtom } from './cctpState'
import { useBtcCctpSwap } from './useBtcCctpSwap'
import { type useCctpTransfer } from './useCctpTransfer'

jest.mock('@cowprotocol/wallet', () => ({ useWalletInfo: () => ({ account: mockOwner }) }))
jest.mock('modules/tradeQuote', () => ({ useQuoteParams: jest.fn() }))
jest.mock('./useCctpWallet', () => ({ useCctpWallet: () => ({}) }))
jest.mock('./useBtcSwapStatus', () => ({ useBtcSwapStatus: () => ({ status: mockStatus, error: null }) }))
jest.mock('./btcSwapQuote.service', () => ({ quoteBtcSwap: jest.fn() }))
jest.mock('./btcSwapSubmission.service', () => ({
  readBtcSwapFunds: jest.fn(),
  submitBtcSwap: jest.fn(),
  approveBtcSwap: jest.fn(),
  updateBtcSwap: jest.fn(),
}))
jest.mock('./btcSwapStatus.service', () => ({ recoverBtcSwap: jest.fn(), finishBtcSwap: jest.fn() }))
let mockStatus: { settlementHash: `0x${string}` } | null = null
const mockOwner = '0x0000000000000000000000000000000000000001'
const quote = { bridge: { owner: mockOwner }, quotedAt: Date.now() } as BtcSwapQuote
const flow = {
  run: async (_label: string, action: () => Promise<void>): Promise<void> => action(),
} as ReturnType<typeof useCctpTransfer>
const store = createStore()
function wrapper({ children }: { children: ReactNode }): ReactNode {
  return <Provider store={store}>{children}</Provider>
}
beforeEach(() => {
  jest.resetAllMocks()
  mockStatus = null
  store.set(cctpTransferAtom, null)
  jest
    .mocked(useQuoteParams)
    .mockReturnValue({ quoteParams: { swapSlippageBps: 50 } } as ReturnType<typeof useQuoteParams>)
  jest.mocked(quoteBtcSwap).mockResolvedValue(quote)
  jest.mocked(readBtcSwapFunds).mockResolvedValue({ approved: true, funded: true })
})

it('invalidates the reviewed quote on amount, route or fee/slippage changes', async () => {
  const { result, rerender } = renderHook(({ key }) => useBtcCctpSwap(flow, key, '0.01', '1000000'), {
    wrapper,
    initialProps: { key: 'route1' },
  })
  await act(async () => result.current.review())
  expect(result.current.quote).toBe(quote)
  expect(result.current.approved).toBe(true)
  rerender({ key: 'route2' })
  expect(result.current.quote).toBeNull()
  await expect(result.current.swap()).rejects.toThrow('Review the route')
  expect(submitBtcSwap).not.toHaveBeenCalled()
  await act(async () => result.current.review())
  jest
    .mocked(useQuoteParams)
    .mockReturnValue({ quoteParams: { swapSlippageBps: 100 } } as ReturnType<typeof useQuoteParams>)
  rerender({ key: 'route2' })
  expect(result.current.quote).toBeNull()
})

it('discards a quote that arrives after the wallet/route context changed', async () => {
  let resolve = (_value: BtcSwapQuote): void => undefined
  jest.mocked(quoteBtcSwap).mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done
      }),
  )
  const { result, rerender } = renderHook(({ key }) => useBtcCctpSwap(flow, key, '0.01', '1000000'), {
    wrapper,
    initialProps: { key: 'route1' },
  })
  const pending = result.current.review()
  rerender({ key: 'route2' })
  await act(async () => {
    resolve(quote)
    await expect(pending).rejects.toThrow('changed')
  })
  expect(result.current.quote).toBeNull()
})

it('waits for the current action then attempts automatic hash recovery only once if persistence fails', async () => {
  store.set(cctpTransferAtom, {
    type: 'wbtcToArc',
    owner: mockOwner,
    orderUid: `0x${'ab'.repeat(56)}`,
    sellAmount: '1000000',
    minimumBuyAmount: '990000',
    validTo: 1000,
  })
  mockStatus = { settlementHash: `0x${'12'.repeat(32)}` }
  jest.mocked(updateBtcSwap).mockRejectedValue(new Error('Other tab holds lock'))
  const run: ReturnType<typeof useCctpTransfer>['run'] = async (_label, action) => {
    await action(() => undefined).catch(() => undefined)
  }
  const { rerender } = renderHook(({ busy }) => useBtcCctpSwap({ ...flow, run, busy }, 'route', undefined, undefined), {
    wrapper,
    initialProps: { busy: 'Submitting swap' },
  })
  expect(updateBtcSwap).not.toHaveBeenCalled()
  rerender({ busy: '' })
  await act(async () => undefined)
  expect(updateBtcSwap).toHaveBeenCalledTimes(1)
  rerender({ busy: 'Other action' })
  rerender({ busy: '' })
  await act(async () => undefined)
  expect(updateBtcSwap).toHaveBeenCalledTimes(1)
})
