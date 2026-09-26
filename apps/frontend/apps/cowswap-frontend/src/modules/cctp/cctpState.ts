import { atomWithStorage } from 'jotai/utils'

import { isAddress, maxUint256, type Address, type Hex } from 'viem'
import { z } from 'zod'

import { CCTP_NETWORKS } from './cctp.const'
import { assertCctpTerms } from './cctp.service'
import { isCctpAsset, type CctpAsset } from './cctpAssets.const'
import { cctpxQuoteSchema } from './cctpx.service'
import { CCTP_STORAGE_KEY, cctpStorage } from './state/migrations/cctpV2Storage.service'
export { CCTP_STORAGE_KEY, cctpStorage } from './state/migrations/cctpV2Storage.service'

const chain = z
  .number()
  .int()
  .refine((id) => CCTP_NETWORKS.some((network) => network.chain.id === id))
const amount = z
  .string()
  .regex(/^(0|[1-9]\d{0,77})$/)
  .refine((value) => /^(0|[1-9]\d{0,77})$/.test(value) && BigInt(value) <= maxUint256)
const hash = z
  .string()
  .regex(/^0x[a-fA-F0-9]{64}$/)
  .transform((value) => value as Hex)
export const cctpTransferSchema = z
  .object({
    swapOrderUid: z
      .string()
      .regex(/^0x[a-fA-F0-9]{112}$/)
      .optional(),
    asset: z.custom<CctpAsset>(isCctpAsset).optional(),
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
