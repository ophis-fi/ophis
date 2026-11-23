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
  setItem(key, value) {
    json.setItem(key, value)
    if (JSON.stringify(readArcReceipt(key)) !== JSON.stringify(value))
      throw new Error('Unable to save Arc bridge tracking.')
  },
  subscribe: (key, callback) => json.subscribe?.(key, () => callback(readArcReceipt(key)), null) ?? (() => undefined),
}

const receipts = atomFamily((key: string) => atomWithStorage<unknown>(key, null, storage, { getOnInit: true }))
export function arcReceiptAtom(owner: string): ReturnType<typeof receipts> {
  return receipts(arcReceiptKey(owner))
}
