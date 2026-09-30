/** @jest-environment node */
import { createStore } from 'jotai'

import fixture from './fixtures/monadDeposit.json'
import { nearTransfersAtom, normalizeNearTransfers, pruneNearTransfers } from './nearDirect.atoms'
import { nearTransferSchema } from './nearDirect.schemas'

it('bounds completed history without deleting failed, expired, or uncertain recovery', () => {
  const transfer = nearTransferSchema.parse(fixture)
  const active = [transfer, { ...transfer, fundingStarted: true }, { ...transfer, status: 'FAILED' as const }]
  const completed = Array.from({ length: 60 }, (_, index) => ({
    ...transfer,
    status: index % 2 ? ('SUCCESS' as const) : ('REFUNDED' as const),
  }))
  expect(pruneNearTransfers([...active, ...completed])).toEqual([...active, ...completed.slice(-50)])
})

it('saves recovery before exposing a deposit and preserves state when storage fails', async () => {
  const values = new Map<string, string>()
  const storage = {
    getItem: (key: string): string | null => values.get(key) ?? null,
    setItem: jest.fn((key: string, value: string) => {
      values.set(key, value)
    }),
    removeItem: (key: string): void => {
      values.delete(key)
    },
  }
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { localStorage: storage } })
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: { request: async (_key: string, action: () => void): Promise<void> => action() },
  })
  const store = createStore()
  const transfer = nearTransferSchema.parse(fixture)
  expect(store.get(nearTransfersAtom)).toEqual([])
  storage.setItem.mockImplementationOnce(() => {
    throw new Error('quota exceeded')
  })
  await expect(store.set(nearTransfersAtom, [transfer])).rejects.toThrow('quota exceeded')
  expect(store.get(nearTransfersAtom)).toEqual([])
  await store.set(nearTransfersAtom, [transfer])
  expect(store.get(nearTransfersAtom)).toEqual([transfer])
  expect(normalizeNearTransfers(JSON.parse(values.get('nearDirectTransfers:v0') ?? 'null'))).toEqual([transfer])
  expect(
    normalizeNearTransfers([{ ...transfer, response: { ...transfer.response, signature: 'forged' } }, null]),
  ).toEqual([])
  Reflect.deleteProperty(globalThis, 'window')
})
