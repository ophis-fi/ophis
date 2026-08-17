import { OPHIS_PARTNER_FEE_RECIPIENT } from '@cowprotocol/common-const'

import { utils } from 'ethers'
import jsonStringify from 'json-stringify-deterministic'

import {
  buildNearQuoteHashInput,
  NearQuoteResponse,
  OphisNearIntentsBridgeProvider,
  withOphisNearQuoteParams,
  wrapNearApiWithOphisQuoteParams,
} from './ophisNearIntentsProvider.service'

// Deterministic fixtures typed against the SDK contract, with GOLDEN values
// computed offline (independent of the implementation, so a struct drift —
// e.g. someone re-adding the depositMode field NEAR removed from their server
// hash — fails loudly). Enum-valued fields carry targeted literal casts: the
// one-click enum VALUES are not importable (transitive dependency), but every
// field name and non-enum type stays compiler-checked.
type NearQuoteRequest = NearQuoteResponse['quoteRequest']

const QUOTE: NearQuoteResponse['quote'] = {
  depositAddress: '0x3333333333333333333333333333333333333333',
  amountIn: '1000000',
  amountInFormatted: '1.0',
  amountInUsd: '1.00',
  minAmountIn: '1000000',
  amountOut: '998000',
  amountOutFormatted: '0.998',
  amountOutUsd: '0.99',
  minAmountOut: '990000',
  timeEstimate: 47,
}

const QUOTE_REQUEST: NearQuoteRequest = {
  dry: false,
  depositMode: 'SIMPLE' as NearQuoteRequest['depositMode'], // echoed by the server, must NOT be hashed
  swapType: 'FLEX_INPUT' as NearQuoteRequest['swapType'],
  slippageTolerance: 100,
  originAsset: 'nep141:eth.omft.near',
  depositType: 'ORIGIN_CHAIN' as NearQuoteRequest['depositType'],
  destinationAsset: 'nep141:base.omft.near',
  amount: '1000000',
  refundTo: '0x1111111111111111111111111111111111111111',
  refundType: 'ORIGIN_CHAIN' as NearQuoteRequest['refundType'],
  recipient: '0x2222222222222222222222222222222222222222',
  recipientType: 'DESTINATION_CHAIN' as NearQuoteRequest['recipientType'],
  deadline: '2026-08-11T00:00:00.000Z',
  referral: 'ophis',
  appFees: [{ recipient: '0x9999999999999999999999999999999999999999', fee: 10 }], // echoed, must NOT be hashed
}

const TIMESTAMP = '2026-08-11T00:00:01.000Z'

const QUOTE_RESPONSE: NearQuoteResponse = {
  timestamp: TIMESTAMP,
  signature: 'ed25519:test-quote-signature',
  quoteRequest: QUOTE_REQUEST,
  quote: QUOTE,
}

const GOLDEN_HASH = '0x8def106a9752a1760713b5527bc7f4f35ea25321bf781f2f4f5eb60eb64d18f5'
// Signature over keccak256(prefix || version || depositAddress || GOLDEN_HASH)
// by the throwaway key 0x777...7; recovery must yield its address.
const GOLDEN_SIGNATURE =
  '0xa564ff66d3adefc56e36979716f73be166fdeb49a2593f75a0abc7ccf51c041a1292faab94efa77f791fc0060f0ab6adde88d2c4c71003228ab2cb7b5a9cf2aa1b'
const GOLDEN_SIGNER = '0xAe72A48c1a36bd18Af168541c53037965d26e4A8'

// Typed access to the protected api member for mocking/inspection.
class TestableNearProvider extends OphisNearIntentsBridgeProvider {
  get testApi(): OphisNearIntentsBridgeProvider['api'] {
    return this.api
  }

  mockAttestation(signature: string): jest.Mock {
    const mock = jest.fn().mockResolvedValue({ signature })
    this.api.getAttestation = mock as unknown as OphisNearIntentsBridgeProvider['api']['getAttestation']
    return mock
  }
}

describe('ophisNearIntentsProvider', () => {
  describe('buildNearQuoteHashInput', () => {
    const input = buildNearQuoteHashInput(QUOTE, QUOTE_REQUEST, TIMESTAMP)

    it('matches the server-side hash exactly (golden value, verified live 2026-08-11)', () => {
      expect(utils.sha256(utils.toUtf8Bytes(jsonStringify(input)))).toBe(GOLDEN_HASH)
    })

    it('excludes depositMode and appFees from the hashed struct', () => {
      expect('depositMode' in input).toBe(false)
      expect('appFees' in input).toBe(false)
    })
  })

  describe('withOphisNearQuoteParams', () => {
    it('injects ophis referral and the 3 bps Safe appFee', () => {
      const out = withOphisNearQuoteParams<NearQuoteRequest>({ ...QUOTE_REQUEST, referral: 'cow' })

      expect(out.referral).toBe('ophis')
      expect(out.appFees).toEqual([{ recipient: OPHIS_PARTNER_FEE_RECIPIENT, fee: 3 }])
      expect(out.amount).toBe(QUOTE_REQUEST.amount)
    })
  })

  describe('wrapNearApiWithOphisQuoteParams', () => {
    it('rebinds api.getQuote so the underlying call receives the injected params', async () => {
      const underlying = jest.fn().mockResolvedValue('quote-result')
      const api = { getQuote: underlying }

      wrapNearApiWithOphisQuoteParams(api)
      const result = await api.getQuote({ ...QUOTE_REQUEST, referral: 'cow' } as never)

      expect(result).toBe('quote-result')
      expect(underlying).toHaveBeenCalledWith(
        expect.objectContaining({
          amount: QUOTE_REQUEST.amount,
          referral: 'ophis',
          appFees: [{ recipient: OPHIS_PARTNER_FEE_RECIPIENT, fee: 3 }],
        }),
      )
    })

    it('is installed by the provider constructor', () => {
      const provider = new TestableNearProvider({})

      // The wrap replaces getQuote with an own-property function shadowing
      // the prototype implementation; a removed constructor wrap fails here.
      expect(provider.testApi.getQuote).not.toBe(Object.getPrototypeOf(provider.testApi).getQuote)
      expect(Object.prototype.hasOwnProperty.call(provider.testApi, 'getQuote')).toBe(true)
    })
  })

  describe('recoverDepositAddress', () => {
    it('computes the corrected hash and recovers the attestation signer', async () => {
      const provider = new TestableNearProvider({})
      const getAttestation = provider.mockAttestation(GOLDEN_SIGNATURE)

      const result = await provider.recoverDepositAddress(QUOTE_RESPONSE)

      expect(getAttestation).toHaveBeenCalledWith({
        quoteHash: GOLDEN_HASH,
        depositAddress: '0x3333333333333333333333333333333333333333',
      })
      expect(result?.address).toBe(GOLDEN_SIGNER)
      expect(result?.quoteHash).toBe(GOLDEN_HASH)
    })

    it('returns null when the deposit address is missing', async () => {
      const provider = new TestableNearProvider({})

      const result = await provider.recoverDepositAddress({
        ...QUOTE_RESPONSE,
        quote: { ...QUOTE, depositAddress: undefined },
      })

      expect(result).toBeNull()
    })
  })
})
