import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { useAtomValue } from 'jotai'

import { resolveOphisPartnerFee, sumVolumeFeeBps } from 'modules/appData'
import { injectedWidgetAppDataPartnerFeeAtom, injectedWidgetHostFeeKindAtom } from 'modules/injectedWidget'
import { isStableStablePair, VolumeFee } from 'modules/volumeFee'

import { OPHIS_PARTNER_FEE_RECIPIENT } from 'ophis/partnerFeeDefault'

import { ResolveLegPartnerFeeFn } from './useBasketLegPartnerFee'

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
  /**
   * The Volume fee this leg's order will carry, resolved from the leg's OWN
   * pair. Must be passed to the quote so the buy amount shown to the user is
   * net of the fee their order actually deducts. Quoting fee-free and then
   * signing with a fee overstates the output and makes a tight minimum-buy
   * limit less fillable than the screen implied. Undefined = fee-exempt leg.
   */
  readonly partnerFee: VolumeFee | undefined
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
  resolveLegPartnerFee: ResolveLegPartnerFeeFn,
): UseBasketQuotesResult {
  const [quotes, setQuotes] = useState<Record<string, BasketLegQuote>>({})
  // The signature the current `quotes` were fanned out for. Compared against the
  // live `legsSig` to invalidate stale quotes synchronously (see the return).
  const [quotedSig, setQuotedSig] = useState('')
  const runIdRef = useRef(0)

  // Quote each leg with the flat fee its order will actually SIGN. With a
  // third-party host fee the signed appData stacks that fee with the Ophis 1 bp
  // base, so the quote must carry the sum (through the same resolver the appData
  // builder uses) or the buy amount shown is 1 bp optimistic and a tight limit is
  // less fillable than the screen implied.
  const widgetPartnerFee = useAtomValue(injectedWidgetAppDataPartnerFeeAtom)
  const hostFee = useAtomValue(injectedWidgetHostFeeKindAtom)
  const resolveLegQuoteFee = useCallback<ResolveLegPartnerFeeFn>(
    (leg) => {
      const legFee = resolveLegPartnerFee(leg)
      const signed = resolveOphisPartnerFee(
        widgetPartnerFee,
        legFee,
        chainId,
        isStableStablePair({ chainId, sellTokenAddress: leg.sellToken, buyTokenAddress: leg.buyToken }),
        hostFee,
      )
      const bps = sumVolumeFeeBps(signed)
      // No flat fee signed (fee-exempt leg, or PI-only): quote exactly what the pipeline says.
      if (bps === undefined) return legFee
      if (legFee) return bps === legFee.volumeBps ? legFee : { ...legFee, volumeBps: bps }
      // Pipeline has nothing (e.g. a third-party embed configured bps: 0) but the
      // order still signs the Ophis policy: quote that, or the buy amount is optimistic.
      return { volumeBps: bps, recipient: OPHIS_PARTNER_FEE_RECIPIENT }
    },
    [resolveLegPartnerFee, widgetPartnerFee, chainId, hostFee],
  )

  // Stable identity for the leg set so the effect only re-fans on real changes.
  // Includes the sell/buy TOKEN addresses AND each leg's resolved fee
  // (legsQuoteSignature), so swapping a token or a fee change at the same
  // slot/amount re-fans instead of reusing a quote for the stale pair or fee.
  const legsSig = useMemo(() => legsQuoteSignature(legs, resolveLegQuoteFee), [legs, resolveLegQuoteFee])

  useEffect(() => {
    if (!legs || legs.length === 0 || !owner) {
      setQuotes({})
      setQuotedSig(legsSig)
      return
    }
    const controller = new AbortController()
    const runId = ++runIdRef.current

    // Seed every leg as loading up front so the UI shows the full set immediately,
    // and record the signature this fan-out is for so the render before this
    // effect ran (with the previous signature) reads as not-ready.
    setQuotes(
      Object.fromEntries(
        legs.map((l) => [
          legKey(l),
          { sellIndex: l.sellIndex, buyIndex: l.buyIndex, buyAmount: null, isLoading: true },
        ]),
      ),
    )
    setQuotedSig(legsSig)

    for (const leg of legs) {
      quoteFn(
        {
          chainId,
          owner,
          sellToken: leg.sellToken,
          buyToken: leg.buyToken,
          sellAmountAtoms: leg.sellAmount.toString(),
          validTo,
          partnerFee: resolveLegQuoteFee(leg),
        },
        controller.signal,
      )
        .then((res) => {
          if (runId !== runIdRef.current) return
          setQuotes((prev) => ({
            ...prev,
            [legKey(leg)]: {
              sellIndex: leg.sellIndex,
              buyIndex: leg.buyIndex,
              buyAmount: res.buyAmountAtoms,
              isLoading: false,
            },
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
    // legsSig captures the leg set (used instead of `legs` to avoid rerunning on
    // reference-only changes); owner/chainId/validTo/quoteFn are stable scalars.
    // resolveLegPartnerFee IS a real dependency: it changes when correlated-token
    // data finishes loading or the injected-widget fee updates, and a stale
    // resolver would quote a leg with a fee it is then signed WITHOUT (or vice
    // versa), diverging from useBuildBasketLegAppData.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [legsSig, owner, chainId, validTo, quoteFn, resolveLegQuoteFee])

  // Synchronous stale-fee invalidation: until the effect has re-fanned for the
  // CURRENT signature (which folds in each leg's resolved fee), treat the quotes
  // as not-ready. Without this, when correlated data or the fee changes the old
  // completed quotes read allQuoted=true for a render while useBuildBasketLegAppData
  // already closes over the new fee, so a confirm in that window would sign a fee
  // different from the one the minimum-buy amount was quoted with.
  const staleFee = quotedSig !== legsSig
  const values = Object.values(quotes)
  const isLoading = staleFee || values.some((q) => q.isLoading)
  const allQuoted = !staleFee && values.length > 0 && values.every((q) => q.buyAmount !== null)

  return { quotes, isLoading, allQuoted }
}
