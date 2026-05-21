import { bridgeOrdersStateSerializer, deserializeQuoteAmounts } from './bridgeOrdersStateSerializer'

// Phase 4 audit DoS-class regression tests: persisted-state hydration must
// not crash on malformed input. Specifically: pre-fix, `deserializeAmount`
// called `CurrencyAmount.fromRawAmount(token, amount)` directly — a bogus
// `amount` string blew up `BigInt(amount)` and the app crashed at render.
// Now the deserializer returns null for the bad amount and the serializer
// drops the parent order.

describe('bridgeOrdersStateSerializer — defensive deserialization', () => {
  beforeEach(() => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined)
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  describe('deserializeQuoteAmounts', () => {
    it('returns null when amounts are completely missing', () => {
      expect(deserializeQuoteAmounts(undefined as never)).toBeNull()
      expect(deserializeQuoteAmounts(null as never)).toBeNull()
    })

    it('returns null when required amount has a non-numeric string', () => {
      const malformed = {
        swapSellAmount: { amount: 'not-a-bigint', token: validToken() },
        swapBuyAmount: validSerializedAmount(),
        swapMinReceiveAmount: validSerializedAmount(),
        bridgeMinReceiveAmount: validSerializedAmount(),
        bridgeFee: validSerializedAmount(),
      } as never
      expect(deserializeQuoteAmounts(malformed)).toBeNull()
    })

    it('returns null when required token is missing chainId', () => {
      const malformed = {
        swapSellAmount: { amount: '1000', token: { address: '0x0', decimals: 18, symbol: 'X', name: 'X' } },
        swapBuyAmount: validSerializedAmount(),
        swapMinReceiveAmount: validSerializedAmount(),
        bridgeMinReceiveAmount: validSerializedAmount(),
        bridgeFee: validSerializedAmount(),
      } as never
      expect(deserializeQuoteAmounts(malformed)).toBeNull()
    })

    it('returns null when required decimals are negative', () => {
      const malformed = {
        swapSellAmount: {
          amount: '1000',
          token: { chainId: 1, address: '0xabc', decimals: -1, symbol: 'X', name: 'X' },
        },
        swapBuyAmount: validSerializedAmount(),
        swapMinReceiveAmount: validSerializedAmount(),
        bridgeMinReceiveAmount: validSerializedAmount(),
        bridgeFee: validSerializedAmount(),
      } as never
      expect(deserializeQuoteAmounts(malformed)).toBeNull()
    })
  })

  describe('bridgeOrdersStateSerializer', () => {
    it('returns empty object when top-level state is not an object', () => {
      // NOTE: console.warn assertion is intentionally omitted — the
      // serializer's _warned flag is module-scoped (deduplicates across the
      // whole session) and may have already fired in earlier tests within
      // this file.
      const result = bridgeOrdersStateSerializer(null as never, () => null)
      expect(result).toEqual({})
    })

    it('drops accounts whose orders are not an array', () => {
      const state = {
        1: { '0xacc': 'not-an-array' as unknown as unknown[] },
      } as never
      const result = bridgeOrdersStateSerializer(state, () => null) as Record<string, unknown>
      expect(result[1]).toEqual({})
    })

    it('drops orders for which the mapping function returns null', () => {
      const state = {
        1: {
          '0xacc': [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
        },
      } as never
      const result = bridgeOrdersStateSerializer<{ id: string }, { id: string }, never>(state, (order) =>
        order.id === 'b' ? null : order,
      ) as Record<string, Record<string, unknown[]>>
      expect(result[1]['0xacc']).toHaveLength(2)
      expect(result[1]['0xacc']).toEqual([{ id: 'a' }, { id: 'c' }])
    })

    it('absorbs throws from the mapping function without crashing the whole atom', () => {
      const state = {
        1: { '0xacc': [{ id: 'a' }, { id: 'crash' }, { id: 'b' }] },
      } as never
      const result = bridgeOrdersStateSerializer<{ id: string }, { id: string }, never>(state, (order) => {
        if (order.id === 'crash') throw new Error('boom')
        return order
      }) as Record<string, Record<string, unknown[]>>
      // Load-bearing assertion: the bad entry is silently dropped, the
      // healthy entries survive. The console.warn dedup is module-scoped
      // so we don't assert on it here (see comment above).
      expect(result[1]['0xacc']).toHaveLength(2)
      expect(result[1]['0xacc']).toEqual([{ id: 'a' }, { id: 'b' }])
    })
  })
})

interface TestSerializedToken {
  chainId: number
  address: string
  decimals: number
  symbol: string
  name: string
}

function validToken(): TestSerializedToken {
  return {
    chainId: 1,
    address: '0x0000000000000000000000000000000000000001',
    decimals: 18,
    symbol: 'X',
    name: 'X',
  }
}

function validSerializedAmount(): { amount: string; token: TestSerializedToken } {
  return { amount: '1000', token: validToken() }
}
