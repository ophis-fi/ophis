import { Currency, CurrencyAmount } from '@cowprotocol/currency'

import { Nullish } from 'types'

/**
 * Render-safe `CurrencyAmount` formatters.
 *
 * Why this exists (2026-05-17 incident series): a `CurrencyAmount` instance
 * hydrated from a stale persisted Jotai atom can have `.currency = undefined`
 * despite its TypeScript type. The instance's own numeric methods —
 * `.toExact()`, `.toSignificant()`, `.toFixed()` — internally read
 * `this.currency.decimals` and throw `TypeError: Cannot read properties of
 * undefined (reading 'decimals')` on a malformed instance. Without these
 * wrappers, a single corrupted amount in the render tree crashes the entire
 * React root to Sentry's "Something went wrong" boundary.
 *
 * Use these for display strings (tooltips, share-links, analytics labels) —
 * NOT for value-bearing arithmetic, where you should fix the underlying data
 * corruption upstream instead of papering over it here.
 */

function isMalformed(amount: Nullish<CurrencyAmount<Currency>>): boolean {
  return !amount || !amount.currency
}

export function safeToExact(amount: Nullish<CurrencyAmount<Currency>>, fallback = ''): string {
  if (isMalformed(amount)) return fallback
  try {
    return (amount as CurrencyAmount<Currency>).toExact()
  } catch {
    return fallback
  }
}

export function safeToSignificant(amount: Nullish<CurrencyAmount<Currency>>, fallback = '0'): string {
  if (isMalformed(amount)) return fallback
  try {
    return (amount as CurrencyAmount<Currency>).toSignificant()
  } catch {
    return fallback
  }
}

export function safeToFixed(amount: Nullish<CurrencyAmount<Currency>>, fallback = '0'): string {
  if (isMalformed(amount)) return fallback
  try {
    const decimals = (amount as CurrencyAmount<Currency>).currency.decimals
    return (amount as CurrencyAmount<Currency>).toFixed(decimals)
  } catch {
    return fallback
  }
}
