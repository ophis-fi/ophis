import { isHypercoreTokenId } from '@cowprotocol/common-utils'
import { areAddressesEqual } from '@cowprotocol/cow-sdk'
import { parseUnits } from '@ethersproject/units'

import {
  ApiError,
  OneClickService,
  OpenAPI,
  QuoteRequest,
  verifyQuoteSignature,
} from '@defuse-protocol/one-click-sdk-typescript'
import { withOphisNearQuoteParams } from 'tradingSdk/ophisNearIntentsProvider.service'
import { z } from 'zod'

import { isRecipientAddress } from 'common/utils/recipientAddress.utils'

import { DIRECT_NEAR_CHAINS } from './nearDirect.constants'
import {
  NearQuote,
  NearToken,
  NearTransfer,
  nearQuoteSchema,
  nearReceiptSchema,
  nearStatusSchema,
  nearTokenSchema,
} from './nearDirect.schemas'

OpenAPI.BASE = 'https://1click.chaindefuser.com'
OpenAPI.TOKEN = process.env.REACT_APP_NEAR_API_KEY || undefined
const confidentiality = process.env.REACT_APP_NEAR_API_KEY ? QuoteRequest.confidentiality.BASIC : undefined

export function nearErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    const body = z.object({ message: z.string().max(500) }).safeParse(error.body)
    if (body.success) return body.data.message
  }
  return error instanceof Error ? error.message : 'NEAR is temporarily unavailable. Please retry.'
}

export function isNearAddress(blockchain: string, value: string): boolean {
  const chain = DIRECT_NEAR_CHAINS[blockchain]
  return !!chain && !/^0x0+$/.test(value) && isRecipientAddress(value, chain.id)
}

export function isSupportedNearToken(token: NearToken): boolean {
  return (
    !!DIRECT_NEAR_CHAINS[token.blockchain] &&
    (token.blockchain !== 'hypercore' || (!!token.contractAddress && isHypercoreTokenId(token.contractAddress))) &&
    (!['btc', 'zec'].includes(token.blockchain) || !token.contractAddress)
  )
}

export async function getNearTokens(): Promise<NearToken[]> {
  const tokens = await OneClickService.getTokens()
  return tokens.flatMap((token) => {
    const parsed = nearTokenSchema.safeParse(token)
    return parsed.success && isSupportedNearToken(parsed.data) ? [parsed.data] : []
  })
}

export function parseNearAmount(amount: string, decimals: number): string {
  if (!/^\d+(\.\d+)?$/.test(amount) || amount.length > 80) throw new Error('Enter a positive amount.')
  const value = parseUnits(amount, decimals)
  if (value.lte(0) || value.toString().length > 78) throw new Error('Enter a positive amount within the token limits.')
  return value.toString()
}

export function verifyNearQuote(value: unknown): NearQuote {
  const response = nearQuoteSchema.parse(value)
  if (!verifyQuoteSignature(response))
    throw new Error('NEAR quote signature is invalid. No deposit address was accepted.')
  return response
}

export function validateNearTransfer(transfer: NearTransfer): void {
  const { response, source, destination } = transfer
  const { quote, quoteRequest: request } = verifyNearQuote(response)
  for (const key of ['virtualChainRecipient', 'virtualChainRefundRecipient', 'customRecipientMsg']) {
    if (request[key] || quote[key]) throw new Error('NEAR returned unsupported recipient routing metadata.')
  }
  const invalid = [
    request.dry,
    request.swapType !== QuoteRequest.swapType.EXACT_INPUT,
    request.depositType !== QuoteRequest.depositType.ORIGIN_CHAIN,
    request.recipientType !== QuoteRequest.recipientType.DESTINATION_CHAIN,
    request.refundType !== QuoteRequest.refundType.ORIGIN_CHAIN,
    request.originAsset !== source.assetId,
    request.destinationAsset !== destination.assetId,
    !isSupportedNearToken(source),
    !isSupportedNearToken(destination),
    !isNearAddress(source.blockchain, request.refundTo),
    !isNearAddress(destination.blockchain, request.recipient),
    !quote.depositAddress,
    !isNearAddress(source.blockchain, String(quote.depositAddress)),
    request.amount !== quote.amountIn,
    BigInt(quote.amountIn) <= 0n,
    BigInt(quote.minAmountOut) <= 0n,
    BigInt(quote.amountOut) < BigInt(quote.minAmountOut),
    !quote.deadline,
  ].some(Boolean)
  if (invalid) {
    throw new Error('NEAR returned an incompatible deposit quote.')
  }
}

export function getNearFundingDeadline(response: NearQuote): number {
  return Math.min(
    Date.parse(response.quoteRequest.deadline),
    Date.parse(response.quote.deadline ?? response.quoteRequest.deadline),
  )
}

export function hasCurrentNearAssets(transfer: NearTransfer, tokens: NearToken[]): boolean {
  return [transfer.source, transfer.destination].every((saved) =>
    tokens.some(
      (live) =>
        live.assetId === saved.assetId &&
        live.blockchain === saved.blockchain &&
        live.decimals === saved.decimals &&
        live.contractAddress === saved.contractAddress &&
        live.symbol === saved.symbol,
    ),
  )
}

export function assertNearRequest(response: NearQuote, request: QuoteRequest): void {
  // The API applies partner sharing/rounding and adds its provider fee. The
  // signed net output is what the user reviews; appFees is not in the signature.
  for (const fee of request.appFees ?? []) {
    const actual =
      response.quoteRequest.appFees?.filter((entry) => areAddressesEqual(entry.recipient, fee.recipient)) ?? []
    const total = actual.reduce((sum, entry) => sum + entry.fee, 0)
    if (total <= 0 || total > fee.fee) throw new Error('NEAR returned unexpected Ophis fees.')
  }
  for (const key of Object.keys(request) as (keyof QuoteRequest)[]) {
    if (key !== 'appFees' && JSON.stringify(response.quoteRequest[key]) !== JSON.stringify(request[key])) {
      throw new Error(`NEAR changed the requested ${key}. Request a new quote.`)
    }
  }
}

export async function requestNearQuote(
  source: NearToken,
  destination: NearToken,
  amount: string,
  recipient: string,
  refundTo: string,
): Promise<NearTransfer> {
  if (!isNearAddress(source.blockchain, refundTo) || !isNearAddress(destination.blockchain, recipient)) {
    throw new Error('Enter valid receiving and refund addresses on their selected networks.')
  }
  if (source.assetId === destination.assetId) throw new Error('Select different assets.')
  const request = withOphisNearQuoteParams<QuoteRequest>(
    {
      dry: false,
      swapType: QuoteRequest.swapType.EXACT_INPUT,
      slippageTolerance: 100,
      originAsset: source.assetId,
      destinationAsset: destination.assetId,
      depositType: QuoteRequest.depositType.ORIGIN_CHAIN,
      amount: parseNearAmount(amount, source.decimals),
      recipient,
      recipientType: QuoteRequest.recipientType.DESTINATION_CHAIN,
      refundTo,
      refundType: QuoteRequest.refundType.ORIGIN_CHAIN,
      // External wallets and UTXO confirmations need more time than EVM signing.
      deadline: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
    },
    confidentiality,
  )
  const response = verifyNearQuote(await OneClickService.getQuote(request))
  assertNearRequest(response, request)
  const transfer: NearTransfer = {
    kind: 'near-direct',
    source,
    destination,
    response,
    status: nearStatusSchema.enum.PENDING_DEPOSIT,
  }
  validateNearTransfer(transfer)
  if (getNearFundingDeadline(response) <= Date.now() + 60_000) throw new Error('The deposit quote has expired.')
  return transfer
}

export function isNewerNearStatus(updatedAt: string | undefined, previous: string | undefined): boolean {
  return !!updatedAt && (!previous || Date.parse(updatedAt) > Date.parse(previous))
}

export function withLatestNearStatus(transfer: NearTransfer, update: NearTransfer | undefined): NearTransfer {
  return update?.response.signature === transfer.response.signature &&
    isNewerNearStatus(update.statusUpdatedAt, transfer.statusUpdatedAt)
    ? { ...transfer, status: update.status, statusUpdatedAt: update.statusUpdatedAt, receipt: update.receipt }
    : transfer
}

export function isExpiredUnfundedNearTransfer(transfer: NearTransfer, now = Date.now()): boolean {
  return (
    transfer.status === 'PENDING_DEPOSIT' &&
    !transfer.fundingStarted &&
    !transfer.transactionHash &&
    now > getNearFundingDeadline(transfer.response) + 86_400_000
  )
}

export async function getNearTransferStatus(transfer: NearTransfer): Promise<NearTransfer> {
  const { depositAddress, depositMemo } = transfer.response.quote
  if (!depositAddress) throw new Error('Missing deposit address.')
  const result = await OneClickService.getExecutionStatus(depositAddress, depositMemo)
  const response = verifyNearQuote(result.quoteResponse)
  if (response.signature !== transfer.response.signature) throw new Error('Status belongs to another deposit quote.')
  const updatedAt = z.string().datetime().parse(result.updatedAt)
  if (!isNewerNearStatus(updatedAt, transfer.statusUpdatedAt)) return transfer
  return {
    ...transfer,
    status: nearStatusSchema.parse(result.status),
    statusUpdatedAt: updatedAt,
    receipt: nearReceiptSchema.parse(result.swapDetails),
  }
}

export async function submitNearDeposit(
  transfer: NearTransfer,
  txHash: string,
  persistFunding: () => Promise<void>,
): Promise<void> {
  const { depositAddress, depositMemo } = transfer.response.quote
  if (!depositAddress || !/^[a-zA-Z0-9_-]{20,150}$/.test(txHash)) throw new Error('Enter a valid transaction hash.')
  // The transfer already happened; preserve recovery even if notification fails.
  await persistFunding()
  await OneClickService.submitDepositTx({ depositAddress, memo: depositMemo, txHash })
}
