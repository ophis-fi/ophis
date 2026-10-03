import { ARC_CHAIN_ID, ARC_USDC_ADDRESS, ophisAcrossApiOptions } from '@cowprotocol/common-const'
import { areAddressesEqual } from '@cowprotocol/cow-sdk'
import { Currency } from '@cowprotocol/currency'

import { cctpRouteAsset, cctpNetwork } from 'entities/cctp'
import { decodeFunctionData, getAddress, isAddress, maxUint256, pad, parseAbi, type Address, type Hex } from 'viem'
import { z } from 'zod'

// Across's verified Arc mainnet deployment: https://docs.across.to/chains-and-contracts
export const ARC_SPOKE_POOL: Address = '0x9b4A302A548c7e313c2b74C461db7b84d3074A84'
export const ACROSS_DEPOSIT_ABI = parseAbi([
  'function deposit(bytes32 depositor,bytes32 recipient,bytes32 inputToken,bytes32 outputToken,uint256 inputAmount,uint256 outputAmount,uint256 destinationChainId,bytes32 exclusiveRelayer,uint32 quoteTimestamp,uint32 fillDeadline,uint32 exclusivityDeadline,bytes message)',
])
const address = z
  .string()
  .refine(isAddress)
  .transform((value) => getAddress(value) as Address)
const uint = z
  .string()
  .regex(/^[1-9]\d{0,77}$/)
  .refine((value) => /^[1-9]\d{0,77}$/.test(value) && BigInt(value) <= maxUint256)
const hex = z
  .string()
  .regex(/^0x(?:[a-fA-F0-9]{2})+$/)
  .transform((value) => value as Hex)
export const acrossQuoteSchema = z.object({
  owner: address,
  recipient: address,
  destination: z.number().int().positive().safe(),
  amount: uint,
  output: uint,
  data: hex,
  quotedAt: z.number().int().nonnegative().safe(),
  expiresAt: z.number().int().positive().safe(),
})
export type AcrossQuote = z.infer<typeof acrossQuoteSchema>
export type AcrossRequest = Pick<AcrossQuote, 'owner' | 'recipient' | 'destination' | 'amount'>

export function isArcAcrossRoute(input: Currency | null | undefined, output: Currency | null | undefined): boolean {
  // Direct USDC transfers use the same canonical assets already exposed by the swap picker.
  return input?.chainId === ARC_CHAIN_ID && cctpRouteAsset(input, output) === 'USDC'
}

export async function acrossApi(path: string, params: Record<string, string>): Promise<unknown> {
  const { apiKey, integratorId } = ophisAcrossApiOptions()
  const query = new URLSearchParams({ ...params, integratorId: integratorId || '' })
  const response = await fetch(`https://app.across.to/api/${path}?${query}`, {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) throw new Error(`Across could not quote or track this transfer (${response.status}). Try again.`)
  return response.json()
}

const apiQuoteSchema = z.object({
  crossSwapType: z.literal('bridgeableToBridgeable'),
  amountType: z.literal('exactInput'),
  inputAmount: uint,
  maxInputAmount: uint,
  expectedOutputAmount: uint,
  minOutputAmount: uint,
  quoteExpiryTimestamp: z.number().int().positive(),
  swapTx: z.object({ chainId: z.literal(5042), to: address, data: hex, value: z.literal('0').optional() }),
})

export async function getAcrossQuote(request: AcrossRequest): Promise<AcrossQuote> {
  const result = await acrossApi('swap/approval', {
    tradeType: 'exactInput',
    originChainId: String(ARC_CHAIN_ID),
    destinationChainId: String(request.destination),
    inputToken: ARC_USDC_ADDRESS,
    outputToken: cctpNetwork(request.destination).usdc,
    amount: request.amount,
    depositor: request.owner,
    recipient: request.recipient,
    skipOriginTxEstimation: 'true',
  })
  return parseAcrossQuote(result, request)
}

export function parseAcrossQuote(result: unknown, request: AcrossRequest): AcrossQuote {
  const response = apiQuoteSchema.parse(result)
  if (
    !areAddressesEqual(response.swapTx.to, ARC_SPOKE_POOL) ||
    response.inputAmount !== request.amount ||
    response.maxInputAmount !== request.amount ||
    response.expectedOutputAmount !== response.minOutputAmount
  )
    throw new Error('Across returned different transfer terms. Refresh the quote.')
  const quote = acrossQuoteSchema.parse({
    ...request,
    output: response.minOutputAmount,
    data: response.swapTx.data,
    quotedAt: Date.now(),
    expiresAt: Math.min(Date.now() + 60_000, response.quoteExpiryTimestamp * 1000),
  })
  assertAcrossQuote(quote)
  return quote
}

export function assertAcrossQuote(quote: AcrossQuote, checkExpiry = true): void {
  acrossQuoteSchema.parse(quote)
  const { args } = decodeFunctionData({ abi: ACROSS_DEPOSIT_ABI, data: quote.data })
  const [owner, recipient, input, output, amount, received, destination, , timestamp, deadline, , message] = args
  const matches = [
    owner.toLowerCase() === pad(quote.owner as Hex).toLowerCase(),
    recipient.toLowerCase() === pad(quote.recipient as Hex).toLowerCase(),
    input.toLowerCase() === pad(ARC_USDC_ADDRESS).toLowerCase(),
    output.toLowerCase() === pad(cctpNetwork(quote.destination).usdc as Hex).toLowerCase(),
    quote.destination !== ARC_CHAIN_ID,
    amount === BigInt(quote.amount),
    received === BigInt(quote.output),
    destination === BigInt(quote.destination),
    message === '0x',
    BigInt(quote.output) <= BigInt(quote.amount),
    BigInt(quote.owner) > 0n,
    BigInt(quote.recipient) > 0n,
    deadline > timestamp,
    quote.expiresAt <= quote.quotedAt + 60_000,
  ]
  if (!matches.every(Boolean)) throw new Error('Across transaction does not match the reviewed transfer.')
  if (
    checkExpiry &&
    (Date.now() >= quote.expiresAt ||
      timestamp * 1000 > Date.now() + 30_000 ||
      Date.now() - timestamp * 1000 > 1_800_000 ||
      deadline * 1000 <= Date.now())
  )
    throw new Error('Quote expired. Refresh the bridge quote.')
}
