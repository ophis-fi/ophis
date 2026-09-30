/** @jest-environment node */
import { isBitcoinAddress, isStarknetAddress, isZcashAddress } from '@cowprotocol/common-utils'
import { AdditionalTargetChainId } from '@cowprotocol/cow-sdk'
import { Base58 } from '@ethersproject/basex'
import { arrayify, concat } from '@ethersproject/bytes'
import { sha256 } from '@ethersproject/sha2'

import { CancelablePromise, OneClickService } from '@defuse-protocol/one-click-sdk-typescript'

import { isRecipientAddress } from 'common/utils/recipientAddress.utils'

import monadDeposit from './fixtures/monadDeposit.json'
import signedDeposit from './fixtures/signedDepositQuote.json'
import signedQuote from './fixtures/signedDryQuote.json'
import { DIRECT_NEAR_CHAINS } from './nearDirect.constants'
import { nearQuoteSchema } from './nearDirect.schemas'
import {
  assertNearRequest,
  getNearFundingDeadline,
  isNearAddress,
  isSupportedNearToken,
  parseNearAmount,
  requestNearQuote,
  verifyNearQuote,
} from './nearDirect.service'

function transparent(prefix: number[]): string {
  const bytes = Uint8Array.from([...prefix, ...Array<number>(20).fill(1)])
  return Base58.encode(concat([bytes, arrayify(sha256(sha256(bytes))).slice(0, 4)]))
}

it('accepts a real service signature and rejects tampered deposit, recipient, amount, and time', () => {
  expect(verifyNearQuote(signedQuote).signature).toBe(signedQuote.signature)
  for (const change of [
    { ...signedQuote, timestamp: '2026-10-01T00:00:00.000Z' },
    { ...signedQuote, quote: { ...signedQuote.quote, amountOut: '9999999999' } },
    { ...signedQuote, quoteRequest: { ...signedQuote.quoteRequest, recipient: '0x' + '22'.repeat(20) } },
    {
      ...signedQuote,
      quoteRequest: { ...signedQuote.quoteRequest, dry: false },
      quote: { ...signedQuote.quote, depositAddress: 'attacker' },
    },
  ])
    expect(() => verifyNearQuote(change)).toThrow()
})

it('validates both directions on all nine requested networks without an EVM address cast', () => {
  const addresses: Record<string, string> = {
    btc: transparent([0]),
    zec: transparent([0x1c, 0xb8]),
    tron: transparent([0x41]),
    monad: '0x' + '11'.repeat(20),
    xlayer: '0x' + '11'.repeat(20),
    hypercore: '0x' + '11'.repeat(20),
    starknet: '0x' + '01'.repeat(32),
    sui: '0x' + '01'.repeat(32),
    sol: Base58.encode(Uint8Array.from(Array<number>(32).fill(1))),
  }
  for (const [chain, address] of Object.entries(addresses)) {
    expect(DIRECT_NEAR_CHAINS[chain]).toBeDefined()
    expect(isNearAddress(chain, address)).toBe(true)
    expect(isNearAddress(chain, 'not-an-address')).toBe(false)
  }
  expect(DIRECT_NEAR_CHAINS.eth?.id).toBe(1)
  expect(isNearAddress('arc', addresses.monad ?? '')).toBe(false)
  expect(isStarknetAddress('0x0')).toBe(false)
  expect(isStarknetAddress('0x' + ((1n << 251n) - 256n).toString(16))).toBe(false)
  const zec = addresses.zec ?? ''
  expect(isZcashAddress(zec.slice(0, -1) + (zec.endsWith('1') ? '2' : '1'))).toBe(false)
  expect(isZcashAddress(transparent([0x1c, 0xbd]))).toBe(true)
  expect(isZcashAddress(transparent([0x1d, 0x25]))).toBe(false)
  expect(isZcashAddress('u1shielded')).toBe(false)
  expect(isBitcoinAddress('1BoatSLRHtKNngkdXEeobR76b53LETtpyT')).toBe(true)
  expect(isRecipientAddress('1BoatSLRHtKNngkdXEeobR76b53LETtpyU', AdditionalTargetChainId.BITCOIN)).toBe(false)
})

it('keeps integer amounts exact and filters the HyperEVM mirror', () => {
  expect(parseNearAmount('9007199254.740993', 6)).toBe('9007199254740993')
  expect(parseNearAmount('0.00000001', 8)).toBe('1')
  for (const amount of ['1e3', '-1', '0', 'NaN', '0.000000001']) expect(() => parseNearAmount(amount, 8)).toThrow()
  const token = { assetId: 'test', blockchain: 'hypercore', symbol: 'USDC', decimals: 8, price: 1 }
  expect(isSupportedNearToken({ ...token, contractAddress: '0x' + '11'.repeat(20) })).toBe(false)
  expect(isSupportedNearToken({ ...token, contractAddress: '0x' + '11'.repeat(16) })).toBe(true)
  const response = nearQuoteSchema.parse(signedQuote)
  response.quote.deadline = '2026-09-30T00:00:00.000Z'
  expect(getNearFundingDeadline(response)).toBe(Date.parse(response.quote.deadline))
})

it('accepts live rounded partner fees while rejecting a changed recipient or increased fee', () => {
  const response = verifyNearQuote(signedDeposit)
  const request = {
    ...response.quoteRequest,
    appFees: [{ recipient: '0x858f0F5eE954846D47155F5203c04aF1819eCeF8', fee: 3 }],
  }
  expect(() => assertNearRequest(response, request)).not.toThrow()
  expect(() => assertNearRequest(response, { ...request, recipient: '0x' + '22'.repeat(20) })).toThrow()
  expect(() =>
    assertNearRequest(response, {
      ...request,
      appFees: [{ ...request.appFees[0], recipient: request.appFees[0]?.recipient ?? '', fee: 1 }],
    }),
  ).toThrow()
  expect(() =>
    verifyNearQuote({ ...signedDeposit, quote: { ...signedDeposit.quote, depositAddress: transparent([0x1c, 0xbd]) } }),
  ).toThrow()
})

it('creates a verified executable quote with the real provider fee response', async () => {
  const response = nearQuoteSchema.parse(monadDeposit.response)
  jest.spyOn(Date, 'now').mockReturnValue(Date.parse(response.quoteRequest.deadline) - 7_200_000)
  const quote = jest
    .spyOn(OneClickService, 'getQuote')
    .mockImplementation(() => new CancelablePromise((resolve) => resolve(response)))
  try {
    const transfer = await requestNearQuote(
      monadDeposit.source,
      monadDeposit.destination,
      '100',
      response.quoteRequest.recipient,
      response.quoteRequest.refundTo,
    )
    expect(transfer.response.signature).toBe(response.signature)
    expect(transfer.status).toBe('PENDING_DEPOSIT')
    expect(quote).toHaveBeenCalledTimes(1)
  } finally {
    jest.restoreAllMocks()
  }
})
