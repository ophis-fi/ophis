import { isAddress, maxUint256, type Address, type Hex } from 'viem'
import { z } from 'zod'

const units = z.string().refine((value) => /^[1-9]\d{0,77}$/.test(value) && BigInt(value) <= maxUint256)

// Shares CCTP's journal: the conversion cannot be repeated while its bridge is pending.
export const btcSwapSchema = z.object({
  type: z.literal('wbtcToArc'),
  owner: z
    .string()
    .refine(isAddress)
    .transform((value) => value as Address),
  orderUid: z.string().regex(/^0x[a-fA-F0-9]{112}$/),
  sellAmount: units,
  minimumBuyAmount: units,
  validTo: z.number().int().positive().safe(),
  settlementHash: z
    .string()
    .regex(/^0x[a-fA-F0-9]{64}$/)
    .transform((value) => value as Hex)
    .optional(),
})
export type BtcSwapPending = z.infer<typeof btcSwapSchema>

export function parseBtcSwap(value: unknown): BtcSwapPending | null {
  const parsed = btcSwapSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}
