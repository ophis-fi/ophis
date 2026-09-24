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
export const CCTP_STORAGE_KEY = 'cctpTransfer:v1'
export const cctpStorage = createJSONStorage<unknown>()
export const cctpTransferAtom = atomWithStorage<unknown>(CCTP_STORAGE_KEY, null, cctpStorage, { getOnInit: true })
