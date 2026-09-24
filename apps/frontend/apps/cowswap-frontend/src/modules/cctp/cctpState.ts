import { atomWithStorage } from 'jotai/utils'

import { isAddress, type Address, type Hex } from 'viem'
import { z } from 'zod'

import { CCTP_NETWORKS, MAX_BURN } from './cctp.const'
import { assertCctpTerms } from './cctp.service'
import { cctpxQuoteSchema } from './cctpx.service'
import { CCTP_STORAGE_KEY, cctpStorage } from './state/migrations/cctpV2Storage.service'
export { CCTP_STORAGE_KEY, cctpStorage } from './state/migrations/cctpV2Storage.service'

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

export const cctpTransferAtom = atomWithStorage<unknown>(CCTP_STORAGE_KEY, null, cctpStorage, { getOnInit: true })
