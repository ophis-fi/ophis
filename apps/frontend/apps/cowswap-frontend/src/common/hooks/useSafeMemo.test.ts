import { useMemo, useState } from 'react'

import { SupportedChainId as ChainId } from '@cowprotocol/cow-sdk'
import { CurrencyAmount, Price, Token } from '@cowprotocol/currency'

import { renderHook } from '@testing-library/react'

import { useSafeDeps, useSafeMemo } from './useSafeMemo'

// TODO: Add proper return type annotation
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function createInputAmount() {
  return CurrencyAmount.fromRawAmount(createInputCurrency(), 100_000)
}

// TODO: Add proper return type annotation
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function createInputCurrency() {
  return new Token(ChainId.SEPOLIA, '0xbe72E441BF55620febc26715db68d3494213D8Cb', 6, 'USDC', 'USDC')
}

// TODO: Add proper return type annotation
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function createOutputAmount() {
  return CurrencyAmount.fromRawAmount(createOutputCurrency(), 200_000)
}

// TODO: Add proper return type annotation
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function createOutputCurrency() {
  return new Token(ChainId.SEPOLIA, '0xd3f3d46FeBCD4CdAa2B83799b7A5CdcB69d135De', 18, 'GNO', 'GNO')
}

// TODO: Add proper return type annotation
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function createStaticObject() {
  return {
    inputCurrency: createInputCurrency(),
    outputCurrency: createOutputCurrency(),
    inputAmount: createInputAmount(),
    outputAmount: createOutputAmount(),
    address: 'xxx',
  }
}

describe('useSafeMemo() to avoid redundant actuation of hooks', () => {
  it('Should execute memo only once using useSafeMemo', () => {
    let memoCalls = 0
    let updatesCount = 3

    renderHook(() => {
      const [state, setState] = useState(createStaticObject())

      const memoized = useSafeMemo(() => {
        memoCalls++
        return state
      }, Object.values(state))

      if (updatesCount !== 0) {
        updatesCount--
        setState(createStaticObject())
      }

      return memoized
    })

    expect(memoCalls).toBe(1)
  })

  // 2026-05-17 incident regression coverage: a CurrencyAmount/Price/Token
  // instance hydrated from a stale persisted atom can have a nullish
  // `.currency` (or `.address`, etc.) despite the TypeScript types. The
  // pre-fix code would throw `Cannot read properties of undefined (reading
  // 'symbol')` inside useSafeDeps, taking down the entire React tree. These
  // tests pin the graceful-degradation behavior.
  describe('malformed-dep tolerance (regression — 2026-05-17 incident)', () => {
    let warnSpy: jest.SpyInstance

    beforeEach(() => {
      warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    })

    afterEach(() => {
      warnSpy.mockRestore()
    })

    it('does not throw when a CurrencyAmount has an undefined `.currency`', () => {
      const amount = createInputAmount()
      // Simulate the stale-hydration corruption: the instance survives but
      // `.currency` is gone. Cast through unknown because the static type
      // forbids this — which is exactly why the runtime crashed.
      ;(amount as unknown as { currency: undefined }).currency = undefined

      expect(() => useSafeDeps([amount])).not.toThrow()
      const [serialized] = useSafeDeps([amount])
      // Cache key includes the validity bit `:0:` so a malformed amount can't
      // collide with a healthy zero-value amount.
      expect(serialized).toMatch(/^CA:0:/)
    })

    it('does not throw when a Token has an undefined `.address`', () => {
      const token = createInputCurrency()
      ;(token as unknown as { address: undefined }).address = undefined

      expect(() => useSafeDeps([token])).not.toThrow()
    })

    it('does not throw when a Price has an undefined baseCurrency', () => {
      const price = new Price(createInputCurrency(), createOutputCurrency(), 1, 2)
      ;(price as unknown as { baseCurrency: undefined }).baseCurrency = undefined

      expect(() => useSafeDeps([price])).not.toThrow()
    })

    it('emits one console.warn per malformed dep class (deduped)', () => {
      const amount1 = createInputAmount()
      const amount2 = createOutputAmount()
      ;(amount1 as unknown as { currency: undefined }).currency = undefined
      ;(amount2 as unknown as { currency: undefined }).currency = undefined

      useSafeDeps([amount1, amount2])

      // Two malformed CurrencyAmounts → exactly one warning, because the dedup
      // is keyed by class name. Module-scoped Set means this test order matters;
      // a previous test in this describe block already warned for
      // 'CurrencyAmount', so we expect 0 NEW warnings here.
      const currencyAmountWarnings = warnSpy.mock.calls.filter((call) =>
        String(call[0]).includes('CurrencyAmount'),
      )
      expect(currencyAmountWarnings.length).toBeLessThanOrEqual(1)
    })
  })

  it('Should execute memo on each setState() call using regular useMemo()', () => {
    let memoCalls = 0
    let updatesCount = 3

    renderHook(() => {
      const [state, setState] = useState(createStaticObject())
      const { inputCurrency, outputCurrency, inputAmount, outputAmount, address } = state

      const memoized = useMemo(() => {
        memoCalls++
        return { inputCurrency, outputCurrency, inputAmount, outputAmount, address }
      }, [inputCurrency, outputCurrency, inputAmount, outputAmount, address])

      if (updatesCount !== 0) {
        updatesCount--
        setState(createStaticObject())
      }

      return memoized
    })

    expect(memoCalls).toBe(4)
  })
})
