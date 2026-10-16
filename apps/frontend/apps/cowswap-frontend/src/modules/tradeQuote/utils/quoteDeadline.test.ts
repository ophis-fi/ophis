import { MAX_VALID_TO_EPOCH } from '@cowprotocol/common-utils'
import {
  AcrossBridgeProvider,
  BridgeQuoteResults,
  CrossChainQuoteAndPost,
  NearIntentsBridgeProvider,
} from '@cowprotocol/sdk-bridging'

import { getOrderValidTo, getQuoteTimeOffset, isQuoteExpired } from './quoteDeadline'

import { DEFAULT_TRADE_QUOTE_STATE, TradeQuoteState } from '../state/tradeQuoteAtom'

interface QuoteDeadlineParams {
  validFor: number | undefined
  quoteValidTo: number | undefined
  localQuoteTimestamp: number | undefined
  expiration?: string
}

// 2024-04-16T10:54:01.334Z
const NOW_TIME = 1713264841334

const getQuoteState = ({
  validFor,
  localQuoteTimestamp,
  quoteValidTo,
  expiration,
}: QuoteDeadlineParams): TradeQuoteState =>
  ({
    ...DEFAULT_TRADE_QUOTE_STATE,
    localQuoteTimestamp,
    quote: {
      quoteResults: {
        tradeParameters: {
          validFor,
        },
        quoteResponse: {
          quote: {
            validTo: quoteValidTo,
          },
          expiration,
        },
      },
    } as CrossChainQuoteAndPost,
  }) as TradeQuoteState

// TODO: Break down this large function into smaller functions
describe('Quote deadline utils', () => {
  describe('getQuoteTimeOffset()', () => {
    it('When expected validTo and quote validTo are the same, then should return 0', () => {
      const validFor = 60 // 1 minute
      const localQuoteTimestamp = 1713167232

      expect(
        getQuoteTimeOffset(
          getQuoteState({
            validFor,
            localQuoteTimestamp,
            quoteValidTo: localQuoteTimestamp + validFor,
          }),
        ),
      ).toEqual(0)
    })

    it('When expected validTo bigger than quote validTo, then should return positive number', () => {
      const validFor = 60 // 1 minute
      const timeOffset = 120 * 60 // 2 hours
      const localQuoteTimestamp = 1713167232

      expect(
        getQuoteTimeOffset(
          getQuoteState({
            validFor,
            localQuoteTimestamp: localQuoteTimestamp + timeOffset,
            quoteValidTo: localQuoteTimestamp + validFor,
          }),
        ),
      ).toEqual(7200)
    })

    it('When expected validTo less than quote validTo, then should return positive number', () => {
      const validFor = 60 // 1 minute
      const timeOffset = -120 * 60 // -2 hours
      const localQuoteTimestamp = 1713167232

      expect(
        getQuoteTimeOffset(
          getQuoteState({
            validFor,
            localQuoteTimestamp: localQuoteTimestamp + timeOffset,
            quoteValidTo: localQuoteTimestamp + validFor,
          }),
        ),
      ).toEqual(-7200)
    })
  })

  describe('getOrderValidTo()', () => {
    beforeEach(() => {
      // Freeze time
      Date.now = jest.fn(() => NOW_TIME)
    })

    it('When time offset is not defined, then should be zero', () => {
      const deadline = 10
      const quoteDeadlineParams = {
        validFor: undefined,
        quoteValidTo: undefined,
        localQuoteTimestamp: undefined,
      }

      expect(getOrderValidTo(deadline, getQuoteState(quoteDeadlineParams))).toEqual(0)
    })

    it('ValidTo should be now + deadline + timeOffset', () => {
      const deadline = 5400 // 1.5 hours
      const offset = 3600 // 1 hour
      const localQuoteTimestamp = Math.floor(NOW_TIME / 1000)
      const quoteDeadlineParams = {
        validFor: deadline,
        quoteValidTo: localQuoteTimestamp + deadline + offset,
        localQuoteTimestamp: localQuoteTimestamp,
      }

      expect(getOrderValidTo(deadline, getQuoteState(quoteDeadlineParams))).toEqual(
        Math.floor(NOW_TIME / 1000 + deadline + offset),
      )
    })

    it('When the result is too big, then it should be capped by MAX_VALID_TO_EPOCH', () => {
      const deadline = 54000000000000000
      const localQuoteTimestamp = Math.floor(NOW_TIME / 1000)
      const quoteDeadlineParams = {
        validFor: deadline,
        quoteValidTo: localQuoteTimestamp + deadline,
        localQuoteTimestamp,
      }

      expect(getOrderValidTo(deadline, getQuoteState(quoteDeadlineParams))).toEqual(MAX_VALID_TO_EPOCH)
    })

    describe('for an Across bridge order', () => {
      // A server clock 2 hours behind the local one, and an Across quote taken a minute ago.
      const offset = 7200
      const now = Math.floor(NOW_TIME / 1000) - offset
      const quoteTimestamp = now - 60
      const bridgeState = (
        providerInfo: BridgeQuoteResults['providerInfo'],
        fillDeadline: number,
      ): TradeQuoteState => ({
        ...getQuoteState({
          validFor: 1800,
          quoteValidTo: now + 1800,
          localQuoteTimestamp: now + offset,
        }),
        bridgeQuote: {
          providerInfo,
          quoteTimestamp,
          quoteBody: JSON.stringify({ timestamp: String(quoteTimestamp), fillDeadline: String(fillDeadline) }),
        } as BridgeQuoteResults,
      })
      const across = new AcrossBridgeProvider().info
      const roomyFill = quoteTimestamp + 7440

      it('caps a forced 60 minute deadline 300 s inside the 3600 s Across quote time buffer', () => {
        expect(getOrderValidTo(3600, bridgeState(across, roomyFill))).toBe(quoteTimestamp + 3300)
      })

      it('caps at 900 s before the Across fill deadline when that comes first', () => {
        expect(getOrderValidTo(3600, bridgeState(across, quoteTimestamp + 3000))).toBe(quoteTimestamp + 2100)
      })

      it('keeps a deadline up to the cap, in server time', () => {
        // now + 3240 is quoteTimestamp + 3300.
        expect(getOrderValidTo(3240, bridgeState(across, roomyFill))).toBe(now + 3240)
        expect(getOrderValidTo(3241, bridgeState(across, roomyFill))).toBe(now + 3240)
        expect(getOrderValidTo(1800, bridgeState(across, roomyFill))).toBe(now + 1800)
      })

      it('leaves other providers alone', () => {
        const other = { ...across, dappId: `${across.dappId}-other` }
        expect(getOrderValidTo(3600, bridgeState(other, roomyFill))).toBe(now + 3600)
      })
    })

    describe('for a NEAR Intents bridge order', () => {
      // Same clocks: the server 2 hours behind, the quote taken a minute ago, its NEAR deadline 30 min on.
      const offset = 7200
      const now = Math.floor(NOW_TIME / 1000) - offset
      const nearDeadline = now - 60 + 1800
      const nearState = (quoteBody: string): TradeQuoteState => ({
        ...getQuoteState({ validFor: 1800, quoteValidTo: now + 1800, localQuoteTimestamp: now + offset }),
        bridgeQuote: { providerInfo: new NearIntentsBridgeProvider({}).info, quoteBody } as BridgeQuoteResults,
      })
      // NEAR's quote deadline, as calculateDeadline writes it and the attested quote echoes it.
      const attested = JSON.stringify({
        deadline: new Date(nearDeadline * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
      })

      it('ends the order 300 s before the deadline NEAR attested, whatever the swap deadline', () => {
        expect(getOrderValidTo(3 * 3600, nearState(attested))).toBe(nearDeadline - 300)
        expect(getOrderValidTo(1800, nearState(attested))).toBe(nearDeadline - 300)
      })

      it('keeps a deadline that ends before that', () => {
        expect(getOrderValidTo(600, nearState(attested))).toBe(now + 600)
      })

      it('places no order when the NEAR deadline cannot be read', () => {
        expect(getOrderValidTo(600, nearState('{}'))).toBe(0)
        expect(getOrderValidTo(600, nearState('not json'))).toBe(0)
      })
    })
  })

  describe('isQuoteExpired()', () => {
    beforeEach(() => {
      // Freeze time
      Date.now = jest.fn(() => NOW_TIME)
    })

    it('When time offset is not defined, then result should be undefined', () => {
      const expirationDate = '2024-04-16T10:54:01.334Z'

      const deadlineParams = {
        validFor: undefined,
        quoteValidTo: undefined,
        localQuoteTimestamp: undefined,
        expiration: expirationDate,
      }

      expect(isQuoteExpired(getQuoteState(deadlineParams))).toBe(undefined)
    })

    it('When current time is further than expiration time, then should return true', () => {
      // Now is 10:54:01, expiration is 10:44:01
      const expirationDate = '2024-04-16T10:44:01.334Z'

      const deadline = 5400 // 1.5 hours
      const localQuoteTimestamp = Math.floor(NOW_TIME / 1000)
      const deadlineParams = {
        validFor: deadline,
        quoteValidTo: localQuoteTimestamp + deadline,
        localQuoteTimestamp: localQuoteTimestamp,
        expiration: expirationDate,
      }

      expect(isQuoteExpired(getQuoteState(deadlineParams))).toBe(true)
    })

    it('When current time is before the expiration time, then should return false', () => {
      // Now is 10:54:01, expiration is 11:04:01
      const expirationDate = '2024-04-16T11:04:01.334Z'

      const localQuoteTimestamp = Math.floor(NOW_TIME / 1000)
      const deadline = 5400 // 1.5 hours
      const deadlineParams = {
        validFor: deadline,
        quoteValidTo: localQuoteTimestamp + deadline,
        localQuoteTimestamp,
        expiration: expirationDate,
      }

      expect(isQuoteExpired(getQuoteState(deadlineParams))).toBe(false)
    })

    it('When there is a time offset, then it should be taken into account', () => {
      // Now is 10:54:01, expiration is 10:44:01
      const expirationDate = '2024-04-16T10:44:01.334Z'

      const deadline = 5400 // 1.5 hours
      const offset = 3600 // 1 hour
      const localQuoteTimestamp = Math.floor(NOW_TIME / 1000)
      const deadlineParams = {
        validFor: deadline,
        quoteValidTo: localQuoteTimestamp + deadline + offset,
        localQuoteTimestamp,
        expiration: expirationDate,
      }

      expect(isQuoteExpired(getQuoteState(deadlineParams))).toBe(true)
    })

    describe('When quote expiration is out of limit', () => {
      // Now is 10:54:01, expiration is 11:54:01 - will expire in 1 hour
      const expirationDate = '2024-04-16T11:54:01.334Z'

      it('And quote is not expired yet, then should return false', () => {
        const expirationGap = 59 // < 1 min
        const localQuoteTimestamp = Math.floor(NOW_TIME / 1000) - expirationGap // Not expired

        const deadline = 5400 // 1.5 hours
        const offset = 0
        const deadlineParams = {
          validFor: deadline,
          quoteValidTo: localQuoteTimestamp + deadline + offset,
          localQuoteTimestamp,
          expiration: expirationDate,
        }

        expect(isQuoteExpired(getQuoteState(deadlineParams))).toBe(false)
      })

      it('And quote is not expired yet, then should return false', () => {
        const expirationGap = 60 // 1 min
        const localQuoteTimestamp = Math.floor(NOW_TIME / 1000) - expirationGap // Expired

        const deadline = 5400 // 1.5 hours
        const offset = 0
        const deadlineParams = {
          validFor: deadline,
          quoteValidTo: localQuoteTimestamp + deadline + offset,
          localQuoteTimestamp,
          expiration: expirationDate,
        }

        expect(isQuoteExpired(getQuoteState(deadlineParams))).toBe(true)
      })
    })
  })
})
