/**
 * Hook: the pre-trade "beat the market" number.
 *
 * Given the current Ophis quote (ReceiveAmountInfo), fetches a reference
 * all-DEX (KyberSwap) quote for the same sell via the CF Pages Function
 * /api/beat-market and computes how many bips better Ophis executes.
 *
 * Scope: SELL orders only (KyberSwap's public routes API is exact-in). Only a
 * POSITIVE saving is ever surfaced: the reference is the aggregator's gross
 * output (the user still pays gas + MEV on a real DEX route), while the Ophis
 * figure is net of network costs, so a non-positive raw delta does NOT mean
 * Ophis is worse — we just hide it rather than show a misleading negative.
 *
 * The endpoint is the CF Pages Function at functions/api/beat-market.ts.
 */
import { useEffect, useRef, useState } from 'react'

import { Currency, CurrencyAmount } from '@cowprotocol/currency'

import type { ReceiveAmountInfo } from 'modules/trade'

const ENDPOINT = '/api/beat-market'
const DEBOUNCE_MS = 500
// The native-ETH sentinel KyberSwap (and OKX-style aggregators) expect.
const AGG_NATIVE = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE'

type BeatMarketApiResponse =
  | { ok: true; data: { source: string; amountOut: string } }
  | { ok: false; error: { code: string; message: string } }

export type BeatMarketStatus = 'idle' | 'pending' | 'ok' | 'error'

export interface BeatMarketState {
  status: BeatMarketStatus
  /** Bips Ophis beats the reference by (always > 0 when present; null otherwise). */
  savingBps: number | null
  /** Ophis net output for the sell (the buy currency). */
  ophisAmount: CurrencyAmount<Currency> | null
  /** Reference all-DEX output for the same sell (same buy currency). */
  marketAmount: CurrencyAmount<Currency> | null
}

const IDLE: BeatMarketState = { status: 'idle', savingBps: null, ophisAmount: null, marketAmount: null }

/** The address an aggregator wants for a currency: the token address, else the native sentinel. */
function aggAddress(currency: Currency): string | null {
  return currency.isToken ? currency.address : AGG_NATIVE
}

export function useBeatMarket(info: ReceiveAmountInfo | null): BeatMarketState {
  const [state, setState] = useState<BeatMarketState>(IDLE)

  const abortRef = useRef<AbortController | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const requestIdRef = useRef(0)

  // Extract a stable request signature from the quote. Only sell orders are
  // comparable (the reference API is exact-in); anything else clears the state.
  const sellCurrency = info?.afterNetworkCosts.sellAmount.currency
  const buyCurrency = info?.afterNetworkCosts.buyAmount.currency
  const sellAtoms = info?.afterNetworkCosts.sellAmount.quotient.toString()
  const ophisOutAtoms = info?.afterNetworkCosts.buyAmount.quotient.toString()
  const chainId = sellCurrency?.chainId
  const sellAddr = sellCurrency ? aggAddress(sellCurrency) : null
  const buyAddr = buyCurrency ? aggAddress(buyCurrency) : null
  const comparable =
    !!info?.isSell && !!chainId && !!sellAddr && !!buyAddr && !!sellAtoms && !!ophisOutAtoms && sellAtoms !== '0'

  // A signature string that changes exactly when the comparison inputs change,
  // so we refetch on a new quote but not on unrelated re-renders.
  const signature = comparable ? `${chainId}|${sellAddr}|${buyAddr}|${sellAtoms}|${ophisOutAtoms}` : ''

  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current)
    abortRef.current?.abort()

    if (!comparable || !info) {
      setState(IDLE)
      return
    }

    const id = ++requestIdRef.current
    setState((s) => ({ ...s, status: 'pending' }))

    timerRef.current = setTimeout(() => {
      const controller = new AbortController()
      abortRef.current = controller
      ;(async () => {
        try {
          const res = await fetch(ENDPOINT, {
            method: 'POST',
            signal: controller.signal,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ chainId, sellToken: sellAddr, buyToken: buyAddr, sellAmount: sellAtoms }),
          })
          if (id !== requestIdRef.current) return // stale (quote moved on)

          if (!res.ok) {
            setState({ status: 'error', savingBps: null, ophisAmount: null, marketAmount: null })
            return
          }
          let body: BeatMarketApiResponse
          try {
            body = (await res.json()) as BeatMarketApiResponse
          } catch {
            setState({ status: 'error', savingBps: null, ophisAmount: null, marketAmount: null })
            return
          }
          // Defense in depth (mirrors the proxy's own cap): a 78-digit uint256 is
          // the max, so anything longer is malformed upstream data, not a price.
          // The `!body.data` guard covers a malformed `{ ok: true }` with no data
          // (the body is a runtime value behind a type assertion, not a real check).
          if (!body.ok || !body.data || !/^[0-9]+$/.test(body.data.amountOut) || body.data.amountOut.length > 80) {
            // No reference (unsupported chain / no route): idle, not an error toast.
            setState(IDLE)
            return
          }

          const ophisOut = BigInt(ophisOutAtoms as string)
          const marketOut = BigInt(body.data.amountOut)
          // Only surface a positive edge (see the file header on gross-vs-net).
          if (marketOut <= 0n || ophisOut <= marketOut) {
            setState(IDLE)
            return
          }
          const savingBps = Number(((ophisOut - marketOut) * 10_000n) / marketOut)
          setState({
            status: 'ok',
            savingBps,
            ophisAmount: info.afterNetworkCosts.buyAmount,
            marketAmount: CurrencyAmount.fromRawAmount(info.afterNetworkCosts.buyAmount.currency, body.data.amountOut),
          })
        } catch {
          if (controller.signal.aborted || id !== requestIdRef.current) return
          setState({ status: 'error', savingBps: null, ophisAmount: null, marketAmount: null })
        }
      })()
    }, DEBOUNCE_MS)

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
    // `signature` captures every input that should trigger a refetch; `info` is
    // read inside but only its (signature-covered) amounts matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature])

  // Abort any in-flight request on unmount.
  useEffect(() => () => abortRef.current?.abort(), [])

  return state
}
