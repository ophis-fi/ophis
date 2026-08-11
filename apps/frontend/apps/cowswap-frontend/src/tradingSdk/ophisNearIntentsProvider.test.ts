import { OPHIS_PARTNER_FEE_RECIPIENT } from '@cowprotocol/common-const'

import { utils } from 'ethers'

import {
  buildNearQuoteHashInput,
  OphisNearIntentsBridgeProvider,
  stableStringifyFlat,
  withOphisNearQuoteParams,
  wrapNearApiWithOphisQuoteParams,
} from './ophisNearIntentsProvider'

// Deterministic fixture with GOLDEN values computed offline (independent of
// the implementation, so a struct drift — e.g. someone re-adding the
// depositMode field NEAR removed from their server hash — fails loudly).
const QUOTE = {
  depositAddress: '0x3333333333333333333333333333333333333333',
  amountIn: '1000000',
  amountInFormatted: '1.0',
  amountInUsd: '1.00',
  minAmountIn: '1000000',
  amountOut: '998000',
  amountOutFormatted: '0.998',
  amountOutUsd: '0.99',
  minAmountOut: '990000',
}
const QUOTE_REQUEST = {
  dry: false,
  depositMode: 'SIMPLE', // present in the response echo, must NOT be hashed
  swapType: 'FLEX_INPUT',
  slippageTolerance: 100,
  originAsset: 'nep141:eth.omft.near',
  depositType: 'ORIGIN_CHAIN',
  destinationAsset: 'nep141:base.omft.near',
  amount: '1000000',
  refundTo: '0x1111111111111111111111111111111111111111',
  refundType: 'ORIGIN_CHAIN',
  recipient: '0x2222222222222222222222222222222222222222',
  recipientType: 'DESTINATION_CHAIN',
  deadline: '2026-08-11T00:00:00.000Z',
  referral: 'ophis',
  appFees: [{ recipient: '0x9999999999999999999999999999999999999999', fee: 10 }], // echoed, must NOT be hashed
}
const TIMESTAMP = '2026-08-11T00:00:01.000Z'

const GOLDEN_HASH = '0x8def106a9752a1760713b5527bc7f4f35ea25321bf781f2f4f5eb60eb64d18f5'
// Signature over keccak256(prefix || version || depositAddress || GOLDEN_HASH)
// by the throwaway key 0x777...7; recovery must yield its address.
const GOLDEN_SIGNATURE =
  '0xa564ff66d3adefc56e36979716f73be166fdeb49a2593f75a0abc7ccf51c041a1292faab94efa77f791fc0060f0ab6adde88d2c4c71003228ab2cb7b5a9cf2aa1b'
const GOLDEN_SIGNER = '0xAe72A48c1a36bd18Af168541c53037965d26e4A8'

describe('ophisNearIntentsProvider', () => {
  describe('buildNearQuoteHashInput', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const input = buildNearQuoteHashInput(QUOTE as any, QUOTE_REQUEST as any, TIMESTAMP as any)

    it('matches the server-side hash exactly (golden value computed offline with json-stable-stringify, verified live 2026-08-11)', () => {
      expect(utils.sha256(utils.toUtf8Bytes(stableStringifyFlat(input)))).toBe(GOLDEN_HASH)
    })

    it('excludes depositMode and appFees from the hashed struct', () => {
      expect('depositMode' in input).toBe(false)
      expect('appFees' in input).toBe(false)
    })
  })

  describe('withOphisNearQuoteParams', () => {
    it('injects ophis referral and the 3 bps Safe appFee', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const out = withOphisNearQuoteParams({ amount: '1', referral: 'cow' }) as any

      expect(out.referral).toBe('ophis')
      expect(out.appFees).toEqual([{ recipient: OPHIS_PARTNER_FEE_RECIPIENT, fee: 3 }])
      expect(out.amount).toBe('1')
    })
  })

  describe('wrapNearApiWithOphisQuoteParams', () => {
    it('rebinds api.getQuote so the underlying call receives the injected params', async () => {
      const underlying = jest.fn().mockResolvedValue('quote-result')
      const api = { getQuote: underlying }

      wrapNearApiWithOphisQuoteParams(api)
      const result = await api.getQuote({ amount: '5', referral: 'cow' })

      expect(result).toBe('quote-result')
      expect(underlying).toHaveBeenCalledWith(
        expect.objectContaining({
          amount: '5',
          referral: 'ophis',
          appFees: [{ recipient: OPHIS_PARTNER_FEE_RECIPIENT, fee: 3 }],
        }),
      )
    })

    it('is installed by the provider constructor', () => {
      const provider = new OphisNearIntentsBridgeProvider({})
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const api = (provider as any).api

      // The wrap replaces getQuote with an own-property function shadowing
      // the prototype implementation; a removed constructor wrap fails here.
      expect(api.getQuote).not.toBe(Object.getPrototypeOf(api).getQuote)
      expect(Object.prototype.hasOwnProperty.call(api, 'getQuote')).toBe(true)
    })
  })

  describe('recoverDepositAddress', () => {
    it('computes the corrected hash and recovers the attestation signer', async () => {
      const provider = new OphisNearIntentsBridgeProvider({})
      const getAttestation = jest.fn().mockResolvedValue({ signature: GOLDEN_SIGNATURE })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(provider as any).api.getAttestation = getAttestation

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await provider.recoverDepositAddress({
        quote: QUOTE,
        quoteRequest: QUOTE_REQUEST,
        timestamp: TIMESTAMP,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any)

      expect(getAttestation).toHaveBeenCalledWith({
        quoteHash: GOLDEN_HASH,
        depositAddress: '0x3333333333333333333333333333333333333333',
      })
      expect(result?.address).toBe(GOLDEN_SIGNER)
      expect(result?.quoteHash).toBe(GOLDEN_HASH)
    })

    it('returns null when the deposit address is missing', async () => {
      const provider = new OphisNearIntentsBridgeProvider({})
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await provider.recoverDepositAddress({ quote: {}, quoteRequest: QUOTE_REQUEST } as any)
      expect(result).toBeNull()
    })
  })
})
