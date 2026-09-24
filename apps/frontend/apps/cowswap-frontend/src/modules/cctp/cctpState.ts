import { atomWithStorage, createJSONStorage } from 'jotai/utils'

import { isAddress, type Address, type Hex } from 'viem'
import { z } from 'zod'

import { CCTP_NETWORKS, MAX_BURN } from './cctp.const'

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
  })
  .refine(
    (value) =>
      value.source !== value.destination &&
      /^\d{1,14}$/.test(value.amount) &&
      /^\d{1,14}$/.test(value.maxFee) &&
      BigInt(value.amount) > BigInt(value.maxFee),
  )

// Retain the burn intent BEFORE requesting a signature. A wallet transport error
// can occur after broadcast; an unknown outcome must never trigger a second burn.
export const CCTP_STORAGE_KEY = 'cctpTransfer:v1'
export const cctpStorage = createJSONStorage<unknown>()
export const cctpTransferAtom = atomWithStorage<unknown>(CCTP_STORAGE_KEY, null, cctpStorage, { getOnInit: true })
