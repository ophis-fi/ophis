/** @jest-environment node */
import { createStore } from 'jotai'

import fixture from './fixtures/monadDeposit.json'
import { nearTransfersAtom, normalizeNearTransfers } from './nearDirect.atoms'
import { nearTransferSchema } from './nearDirect.schemas'

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
