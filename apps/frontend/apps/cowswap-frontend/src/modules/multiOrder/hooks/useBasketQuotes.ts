import { useEffect, useMemo, useRef, useState } from 'react'

import { DecomposedLeg } from '../pure/decomposition'
import { legQuoteKey, legsQuoteSignature } from '../pure/quoteSignature'
import { BasketLegQuote } from '../types'

/** One leg's quote request (the port the container wires to CoW's quote API). */
export interface BasketLegQuoteRequest {
  readonly chainId: number
  readonly owner: string
  readonly sellToken: string
  readonly buyToken: string
  readonly sellAmountAtoms: string
  readonly validTo: number
}

/**
 * Injectable quote fetcher: resolves one leg's buy amount (atoms) for a sell.
 * The container supplies the CoW-native implementation (OrderBookApi.getQuote);
 * injecting it keeps the fan-out/cancellation logic here decoupled and testable.
 */
export type BasketQuoteFn = (req: BasketLegQuoteRequest, signal: AbortSignal) => Promise<{ buyAmountAtoms: string }>

const legKey = legQuoteKey

export interface UseBasketQuotesResult {
  readonly quotes: Record<string, BasketLegQuote>
  readonly isLoading: boolean
  readonly allQuoted: boolean
}

/**
 * Fan out one quote per leg and track their states. Every quote for the current
 * leg set shares one AbortController, so a composition change (or unmount)
 * cancels the whole in-flight fan-out before starting the next. Results are
 * keyed by `sellIndex:buyIndex`.
 */
export function useBasketQuotes(
  legs: readonly DecomposedLeg[] | null,
  owner: string | undefined,
  chainId: number,
  validTo: number,
  quoteFn: BasketQuoteFn,
): UseBasketQuotesResult {
  const [quotes, setQuotes] = useState<Record<string, BasketLegQuote>>({})
  const runIdRef = useRef(0)

  // Stable identity for the leg set so the effect only re-fans on real changes.
  // Includes the sell/buy TOKEN addresses (legsQuoteSignature), so swapping a
  // token at the same slot/amount re-fans instead of reusing the stale pair's quote.
  const legsSig = useMemo(() => legsQuoteSignature(legs), [legs])

  useEffect(() => {
    if (!legs || legs.length === 0 || !owner) {
      setQuotes({})
      return
    }
    const controller = new AbortController()
    const runId = ++runIdRef.current

    // Seed every leg as loading up front so the UI shows the full set immediately.
    setQuotes(
      Object.fromEntries(
        legs.map((l) => [legKey(l), { sellIndex: l.sellIndex, buyIndex: l.buyIndex, buyAmount: null, isLoading: true }]),
      ),
    )

    for (const leg of legs) {
      quoteFn(
        {
          chainId,
          owner,
          sellToken: leg.sellToken,
          buyToken: leg.buyToken,
          sellAmountAtoms: leg.sellAmount.toString(),
          validTo,
        },
        controller.signal,
      )
        .then((res) => {
          if (runId !== runIdRef.current) return
          setQuotes((prev) => ({
            ...prev,
            [legKey(leg)]: { sellIndex: leg.sellIndex, buyIndex: leg.buyIndex, buyAmount: res.buyAmountAtoms, isLoading: false },
          }))
        })
        .catch((e: unknown) => {
          if (runId !== runIdRef.current || controller.signal.aborted) return
          setQuotes((prev) => ({
            ...prev,
            [legKey(leg)]: {
              sellIndex: leg.sellIndex,
              buyIndex: leg.buyIndex,
              buyAmount: null,
              isLoading: false,
              error: e instanceof Error ? e.message : String(e),
            },
          }))
        })
    }

    return () => controller.abort()
    // legsSig captures the leg set; the rest are stable scalars.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [legsSig, owner, chainId, validTo, quoteFn])

  const values = Object.values(quotes)
  const isLoading = values.some((q) => q.isLoading)
  const allQuoted = values.length > 0 && values.every((q) => q.buyAmount !== null)

  return { quotes, isLoading, allQuoted }
}
