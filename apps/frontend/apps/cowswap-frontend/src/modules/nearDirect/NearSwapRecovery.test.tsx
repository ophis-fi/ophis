import { PrimitiveAtom, Provider, createStore } from 'jotai'

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'

import fixture from './fixtures/monadDeposit.json'
import { nearTokensAtom, nearTransfersAtom } from './nearDirect.atoms'
import { NearTransfer, nearTransferSchema } from './nearDirect.schemas'
import { NearSwapRecovery } from './NearSwapRecovery.container'

const mockRefetch = jest.fn()
const mockWrite = jest.fn()
jest.mock('./nearDirect.atoms', () => {
  const { atom } = jest.requireActual('jotai')
  const transfers = atom([])
  const status = atom({})
  return {
    nearTokensAtom: atom({}),
    nearTransferStatusAtom: () => status,
    nearTransfersAtom: atom(
      (get: (key: unknown) => NearTransfer[]) => get(transfers),
      (
        get: (key: unknown) => NearTransfer[],
        set: (key: unknown, value: NearTransfer[]) => void,
        update: (current: NearTransfer[]) => NearTransfer[],
      ) => {
        mockWrite()
        set(transfers, typeof update === 'function' ? update(get(transfers)) : update)
      },
    ),
  }
})
jest.mock('./NearTransferCard.container', () => ({ NearTransferCard: () => <section>Saved swap details</section> }))
jest.mock('@cowprotocol/ui', () => ({ ...jest.requireActual('@cowprotocol/ui'), ButtonSecondary: 'button' }))

const writableTokensAtom = nearTokensAtom as unknown as PrimitiveAtom<{
  error: Error | null
  refetch: typeof mockRefetch
}>

function setup(transfers: NearTransfer[]): { store: ReturnType<typeof createStore> } & ReturnType<typeof render> {
  const store = createStore()
  store.set(nearTransfersAtom, transfers)
  store.set(writableTokensAtom, { error: null, refetch: mockRefetch })
  const view = render(
    <Provider store={store}>
      <NearSwapRecovery allowFunding={false} />
    </Provider>,
  )
  return { store, ...view }
}

beforeEach(() => {
  mockWrite.mockReset()
  mockRefetch.mockReset()
})

it('starts completed swaps compact and keeps asset retry available while funding is paused', () => {
  const { store, container } = setup([{ ...nearTransferSchema.parse(fixture), status: 'REFUNDED' }])
  expect(container.querySelector('details')?.open).toBe(false)
  expect(screen.getByText('Refunded')).toBeTruthy()
  act(() =>
    store.set(writableTokensAtom, {
      error: new Error('offline'),
      refetch: mockRefetch,
    }),
  )
  fireEvent.click(screen.getByRole('button', { name: 'Retry loading assets' }))
  expect(mockRefetch).toHaveBeenCalledTimes(1)
})

it('clears all rows without deleting active recovery, persists across remount and restores from history', async () => {
  const transfer = {
    ...nearTransferSchema.parse(fixture),
    fundingStarted: true,
    transactionHash: '0x' + 'ab'.repeat(32),
  }
  const { store, unmount } = setup([transfer])
  fireEvent.click(screen.getByRole('button', { name: 'Clear from page', exact: true }))
  await screen.findByText('Page cleared. Your swaps are saved in History.')
  expect(store.get(nearTransfersAtom)).toEqual([{ ...transfer, archived: true }])
  expect(screen.queryByText('Checking deposit')?.closest('[hidden]')).not.toBeNull()
  unmount()
  render(
    <Provider store={store}>
      <NearSwapRecovery allowFunding={false} />
    </Provider>,
  )
  expect(screen.getByText('Page cleared. Your swaps are saved in History.')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'History (1)' }))
  expect(screen.getByText('Checking deposit').closest('[hidden]')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: /Restore .* to activity/ }))
  await waitFor(() => expect(store.get(nearTransfersAtom)).toEqual([{ ...transfer, archived: false }]))
  fireEvent.click(screen.getByRole('button', { name: 'Back to activity' }))
  expect(screen.getByText('Checking deposit').closest('[hidden]')).toBeNull()
})

it('leaves recovery visible if saving the archive fails', async () => {
  const transfer = { ...nearTransferSchema.parse(fixture), status: 'REFUNDED' as const }
  const { store } = setup([transfer])
  mockWrite.mockImplementationOnce(() => {
    throw new Error('Storage unavailable')
  })
  fireEvent.click(screen.getByRole('button', { name: /Clear .* from page/ }))
  await screen.findByText('Storage unavailable')
  expect(store.get(nearTransfersAtom)).toEqual([transfer])
  expect(screen.queryByText('Page cleared. Your swaps are saved in History.')).toBeNull()
})

it('does not clear a newly initiated swap that was absent when Clear from page was clicked', async () => {
  const transfer = { ...nearTransferSchema.parse(fixture), status: 'REFUNDED' as const }
  const next = { ...transfer, response: { ...transfer.response, signature: 'another-swap' } }
  const { store } = setup([transfer])
  mockWrite.mockImplementationOnce(() => store.set(nearTransfersAtom, [transfer, next]))
  fireEvent.click(screen.getByRole('button', { name: 'Clear from page', exact: true }))
  await waitFor(() => expect(store.get(nearTransfersAtom)).toEqual([{ ...transfer, archived: true }, next]))
})
