import { atom } from 'jotai'
import { atomFamily, atomWithStorage, createJSONStorage } from 'jotai/utils'

import { getAddressKey } from '@cowprotocol/cow-sdk'

import { z } from 'zod'

export const receiptSchema = z.object({
  provider: z.enum(['Across', 'Relay']),
  id: z.string().regex(/^0x[0-9a-f]{64}$/i),
  destination: z.number().int().positive(),
  minimum: z.string().regex(/^[1-9]\d{0,77}$/),
  nonce: z.number().int().nonnegative(),
  hash: z
    .string()
    .regex(/^0x[0-9a-f]{64}$/i)
    .optional(),
})
export type Receipt = z.infer<typeof receiptSchema>

export const arcReceiptKey = (owner: string): string => 'ophisArcBridge:' + getAddressKey(owner) + ':v0'
const json = createJSONStorage<unknown>()

// Preserve invalid JSON as an occupied record so a damaged journal cannot authorize a second deposit.
export function readArcReceipt(key: string): unknown {
  const raw = localStorage.getItem(key)
  return raw === null ? null : json.getItem(key, raw)
}

const storage: typeof json = {
  ...json,
  getItem(key) {
    try {
      return readArcReceipt(key)
    } catch {
      return null
    }
  },
  subscribe: (key, callback) => json.subscribe?.(key, () => callback(readArcReceipt(key)), null) ?? (() => undefined),
}

const receipts = atomFamily((key: string) => {
  // The public atom commits to storage before publishing a new value to the UI.
  const view = atomWithStorage<unknown>(key, null, { ...storage, setItem: () => {} }, { getOnInit: true })
  return atom(
    (get) => get(view),
    (_get, set, next: Receipt | null) => {
      json.setItem(key, next)
      if (JSON.stringify(readArcReceipt(key)) !== JSON.stringify(next))
        throw new Error('Unable to save Arc bridge tracking.')
      set(view, next)
    },
  )
})
export function arcReceiptAtom(owner: string): ReturnType<typeof receipts> {
  return receipts(arcReceiptKey(owner))
}
