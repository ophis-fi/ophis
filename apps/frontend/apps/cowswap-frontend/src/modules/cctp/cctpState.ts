import { atomWithStorage, createJSONStorage } from 'jotai/utils'

import { isAddress, type Address, type Hex } from 'viem'
import { z } from 'zod'

import { CCTP_NETWORKS, MAX_BURN } from './cctp.const'
import { assertCctpTerms } from './cctp.service'
import { cctpxQuoteSchema } from './cctpx.service'

const chain = z
  .number()
  .int()
  .refine((id) => CCTP_NETWORKS.some((network) => network.chain.id === id))
const amount = z
  .string()
  .regex(/^\d{1,14}$/)
  .refine((value) => /^\d{1,14}$/.test(value) && BigInt(value) <= MAX_BURN)
const hash = z
  .string()
  .regex(/^0x[a-fA-F0-9]{64}$/)
  .transform((value) => value as Hex)
export const cctpTransferSchema = z
  .object({
    asset: z.enum(['USDC', 'EURC', 'cirBTC']).optional(),
    expanded: cctpxQuoteSchema.optional(),
    source: chain,
    destination: chain,
    owner: z
      .string()
      .refine(isAddress)
      .transform((value) => value as Address),
    amount,
    maxFee: amount,
    quotedAt: z.number().int().nonnegative().safe(),
    sourceNonce: z.number().int().nonnegative().safe().optional(),
    burnHash: hash.optional(),
    mintHash: hash.optional(),
    claimNonce: z.number().int().nonnegative().safe().optional(),
  })
  .refine((value) => {
    try {
      assertCctpTerms(value)
      return true
    } catch {
      return false
    }
  })

// Retain the burn intent BEFORE requesting a signature. A wallet transport error
// can occur after broadcast; an unknown outcome must never trigger a second burn.
export const CCTP_STORAGE_KEY = 'cctpTransfer:v2'
const legacyKey = 'cctpTransfer:v1'
const jsonStorage = createJSONStorage<unknown>()
// Read old USDC journals in place; migrate on the first locked update, never
// during hydration. A legacy guard prevents old tabs from starting another burn.
export const cctpStorage: typeof jsonStorage = {
  getItem: (key, initialValue) => jsonStorage.getItem(key, null) ?? jsonStorage.getItem(legacyKey, initialValue),
  setItem: (key, value) => {
    if (value === null) {
      jsonStorage.setItem(legacyKey, null)
      jsonStorage.setItem(key, null)
    } else {
      jsonStorage.setItem(key, value)
      const guard = { version: 2, recoveryKey: CCTP_STORAGE_KEY }
      jsonStorage.setItem(legacyKey, guard)
      if (JSON.stringify(jsonStorage.getItem(legacyKey, null)) !== JSON.stringify(guard))
        throw new Error('Unable to protect bridge recovery from an older tab. Nothing was signed.')
    }
  },
  removeItem: (key) => cctpStorage.setItem(key, null),
  subscribe: (key, callback, initialValue) => {
    const changed = (): void => callback(cctpStorage.getItem(key, initialValue))
    const current = jsonStorage.subscribe?.(key, changed, initialValue)
    const legacy = jsonStorage.subscribe?.(legacyKey, changed, initialValue)
    return () => {
      current?.()
      legacy?.()
    }
  },
}
export const cctpTransferAtom = atomWithStorage<unknown>(CCTP_STORAGE_KEY, null, cctpStorage, { getOnInit: true })
