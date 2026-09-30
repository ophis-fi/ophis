import { GetExecutionStatusResponse, QuoteRequest } from '@defuse-protocol/one-click-sdk-typescript'
import { z } from 'zod'

const integer = z.string().regex(/^\d+$/).max(78)
const usd = z
  .string()
  .regex(/^\d+(\.\d{1,18})?$/)
  .max(100)
export const nearTokenSchema = z.object({
  assetId: z.string().min(1).max(512),
  blockchain: z.string(),
  symbol: z.string().min(1).max(40),
  decimals: z.number().int().min(0).max(36),
  contractAddress: z.string().optional(),
  price: z.number().finite().nonnegative(),
})
export type NearToken = z.infer<typeof nearTokenSchema>

export const nearQuoteSchema = z
  .object({
    correlationId: z.string(),
    timestamp: z.string().datetime(),
    signature: z.string(),
    quoteRequest: z
      .object({
        dry: z.boolean(),
        swapType: z.nativeEnum(QuoteRequest.swapType),
        slippageTolerance: z.number().int(),
        originAsset: z.string(),
        destinationAsset: z.string(),
        depositType: z.nativeEnum(QuoteRequest.depositType),
        amount: integer,
        refundTo: z.string(),
        refundType: z.nativeEnum(QuoteRequest.refundType),
        recipient: z.string(),
        recipientType: z.nativeEnum(QuoteRequest.recipientType),
        deadline: z.string().datetime(),
        confidentiality: z.nativeEnum(QuoteRequest.confidentiality).optional(),
        referral: z.string().optional(),
        appFees: z
          .array(z.object({ recipient: z.string(), fee: z.number().finite().min(0).max(10_000) }))
          .max(20)
          .optional(),
      })
      .passthrough(),
    quote: z
      .object({
        amountIn: integer,
        amountOut: integer,
        minAmountIn: integer,
        minAmountOut: integer,
        amountInFormatted: z.string(),
        amountOutFormatted: z.string(),
        amountInUsd: usd,
        amountOutUsd: usd,
        timeEstimate: z.number().nonnegative(),
        depositAddress: z.string().optional(),
        depositMemo: z.string().optional(),
        deadline: z.string().datetime().optional(),
        timeWhenInactive: z.string().datetime().optional(),
        refundFee: integer.optional(),
        withdrawFee: integer.optional(),
      })
      .passthrough(),
  })
  .passthrough()
export type NearQuote = z.infer<typeof nearQuoteSchema>
export const nearStatusSchema = z.nativeEnum(GetExecutionStatusResponse.status)
export const nearReceiptSchema = z.object({
  amountOut: integer.optional(),
  refundedAmount: integer.optional(),
  destinationChainTxHashes: z.array(z.object({ hash: z.string().regex(/^[a-zA-Z0-9_-]{20,150}$/) })).max(100),
})
export const nearTransferSchema = z.object({
  kind: z.literal('near-direct'),
  source: nearTokenSchema,
  destination: nearTokenSchema,
  response: nearQuoteSchema,
  status: nearStatusSchema,
  receipt: nearReceiptSchema.optional(),
  transactionHash: z.string().optional(),
  fundingStarted: z.boolean().optional(),
  fundingError: z.string().optional(),
  fundingNonce: z.number().int().nonnegative().optional(),
  statusUpdatedAt: z.string().datetime().optional(),
})
export type NearTransfer = z.infer<typeof nearTransferSchema>
