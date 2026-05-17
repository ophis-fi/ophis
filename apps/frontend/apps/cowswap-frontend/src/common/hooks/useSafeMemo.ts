import { EffectCallback, useEffect, useMemo } from 'react'

import { getAddressKey } from '@cowprotocol/cow-sdk'
import { Currency, CurrencyAmount, NativeCurrency, Percent, Price, Token } from '@cowprotocol/currency'

// Dedupe malformed-dep warnings per session by the class of the offending
// instance so a stale-persisted-atom bug surfaces in DevTools/Sentry once
// (enough to drive root-cause work) without flooding the console on every
// re-render. Module-level — survives component remounts but resets on full
// page reload (which is the right granularity for a session signal).
const malformedDepsWarned = new Set<string>()
function warnMalformedDep(klass: string, missingField: string): void {
  if (malformedDepsWarned.has(klass)) return
  malformedDepsWarned.add(klass)
  console.warn(
    `[useSafeMemo] dropping malformed ${klass} dep (missing ${missingField}); ` +
      'memo key degraded to empty fallback. Upstream currency hydration likely corrupt — ' +
      'check stale Jotai-persisted atoms.',
  )
}

// 2026-05-17 incident hardening: every serializer below previously dereferenced
// `dep.currency.symbol` (etc.) without guards. A single malformed
// CurrencyAmount/Price/Token — e.g. an instance hydrated from localStorage
// where the underlying Currency lookup later failed — would throw
// `TypeError: Cannot read properties of undefined (reading 'symbol')` and,
// because useSafeMemo wraps useMemo for the entire render tree, the whole
// app would crash to the Sentry "Something went wrong" boundary.
//
// The chain.symbol → string conversion is best-effort cache-key generation,
// never a security boundary — so degrade gracefully and emit a one-shot
// session warning (`warnMalformedDep`) per class so we still notice the
// upstream data-corruption bug. The constructor-name prefix + currency-
// validity bit (`1:` / `0:`) keep malformed and healthy zero-amounts in
// distinct cells of the memo cache so a malformed instance can't collide
// with a legitimate zero-value of the same toExact() string.

function serializeNativeCurrency(dep: NativeCurrency): string {
  if (!dep.symbol) warnMalformedDep('NativeCurrency', 'symbol')
  return `NC:${dep.symbol ?? ''}:${dep.chainId ?? ''}`
}

function serializeToken(dep: Token): string {
  if (!dep.address) warnMalformedDep('Token', 'address')
  return `T:${getAddressKey(dep.address ?? '')}:${dep.chainId ?? ''}`
}

function serializeCurrencyAmount(dep: CurrencyAmount<Currency>): string {
  const currency = dep.currency
  if (!currency) warnMalformedDep('CurrencyAmount', 'currency')
  const validity = currency ? '1' : '0'
  // `dep.toExact()` internally reads `this.currency.decimals` and itself
  // throws if currency is undefined. Wrap it so the memo-key derivation
  // never crashes on hydration-corrupted instances. For malformed amounts,
  // fall back to `.quotient.toString()` (which doesn't depend on currency)
  // so two distinct corrupted amounts still get distinct memo keys —
  // otherwise every malformed instance collapses to a single memo cell
  // and recomputes get suppressed across genuinely different inputs.
  // (Codex review of fix/codex-flagged-gaps, 2026-05-17.)
  let key = ''
  try {
    key = dep.toExact()
  } catch {
    try {
      key = `<bad>:${dep.quotient.toString()}`
    } catch {
      key = '<bad>'
    }
  }
  return `CA:${validity}:${key}:${currency?.symbol ?? ''}:${currency?.chainId ?? ''}`
}

function currencyKey(c: Currency | undefined): string {
  return `${c?.symbol ?? ''}:${c?.chainId ?? ''}`
}

function serializePrice(dep: Price<Currency, Currency>): string {
  if (!dep.baseCurrency || !dep.quoteCurrency) warnMalformedDep('Price', 'baseCurrency|quoteCurrency')
  const validity = dep.baseCurrency && dep.quoteCurrency ? '1' : '0'
  // Numerator/denominator are JSBI/BigInt-like — `.toString()` can throw if
  // the instance was hydrated half-formed. Guard so memo-key derivation
  // never takes down the render tree.
  let num = ''
  let den = ''
  try {
    num = dep.numerator.toString()
    den = dep.denominator.toString()
  } catch {
    num = '<bad>'
    den = '<bad>'
  }
  return `P:${validity}:${num}:${den}:${currencyKey(dep.baseCurrency)}:${currencyKey(dep.quoteCurrency)}`
}

export function useSafeDeps(deps: unknown[]): unknown[] {
  return deps.map((dep) => {
    if (dep instanceof NativeCurrency) return serializeNativeCurrency(dep)
    if (dep instanceof Token) return serializeToken(dep)
    if (dep instanceof CurrencyAmount) return serializeCurrencyAmount(dep)
    if (dep instanceof Percent) return dep.toFixed(6)
    if (dep instanceof Price) return serializePrice(dep)
    return dep
  })
}

export function useSafeEffect(memoCall: EffectCallback, deps: unknown[]): void {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(memoCall, useSafeDeps(deps))
}

/**
 * UseMemo effectively (by values) compare only primitive types and compare objects by links
 * To get the best performance we need process objects changes manually
 */
export function useSafeMemo<T>(memoCall: () => T, deps: unknown[]): T {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(memoCall, useSafeDeps(deps))
}

export function useSafeMemoObject<T extends { [key: string]: unknown }>(depsObj: T): typeof depsObj {
  return useSafeMemo<typeof depsObj>(() => depsObj, Object.values(depsObj))
}
