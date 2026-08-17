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
const ERROR: BeatMarketState = { status: 'error', savingBps: null, ophisAmount: null, marketAmount: null }

interface BeatMarketRequest {
  chainId: number
  sellToken: string
  buyToken: string
  sellAmount: string
  ophisOutAtoms: string
  buyAmount: CurrencyAmount<Currency>
  signature: string
}

/** The address an aggregator wants for a currency: the token address, else the native sentinel. */
function aggAddress(currency: Currency): string | null {
  return currency.isToken ? currency.address : AGG_NATIVE
}

function buildBeatMarketRequest(info: ReceiveAmountInfo | null): BeatMarketRequest | null {
  if (!info?.isSell) return null
  const sellAmount = info.afterNetworkCosts.sellAmount
  const buyAmount = info.afterNetworkCosts.buyAmount
  const chainId = sellAmount.currency.chainId
  const sellToken = aggAddress(sellAmount.currency)
  const buyToken = aggAddress(buyAmount.currency)
  const sellAtoms = sellAmount.quotient.toString()
  const ophisOutAtoms = buyAmount.quotient.toString()
  if (!chainId || !sellToken || !buyToken || sellAtoms === '0') return null

  return {
    chainId,
    sellToken,
    buyToken,
    sellAmount: sellAtoms,
    ophisOutAtoms,
    buyAmount,
    signature: `${chainId}|${sellToken}|${buyToken}|${sellAtoms}|${ophisOutAtoms}`,
  }
}

function isValidMarketResponse(body: BeatMarketApiResponse): body is Extract<BeatMarketApiResponse, { ok: true }> {
  return (
    body.ok &&
    !!body.data &&
    /^[0-9]+$/.test(body.data.amountOut) &&
    body.data.amountOut.length <= 80
  )
}

function buildMarketState(request: BeatMarketRequest, amountOut: string): BeatMarketState {
  const ophisOut = BigInt(request.ophisOutAtoms)
  const marketOut = BigInt(amountOut)
  if (marketOut <= 0n || ophisOut <= marketOut) return IDLE

  return {
    status: 'ok',
    savingBps: Number(((ophisOut - marketOut) * 10_000n) / marketOut),
    ophisAmount: request.buyAmount,
    marketAmount: CurrencyAmount.fromRawAmount(request.buyAmount.currency, amountOut),
  }
}

async function fetchBeatMarketState(request: BeatMarketRequest, signal: AbortSignal): Promise<BeatMarketState> {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chainId: request.chainId,
      sellToken: request.sellToken,
      buyToken: request.buyToken,
      sellAmount: request.sellAmount,
    }),
  })
  if (!res.ok) return ERROR

  let body: BeatMarketApiResponse
  try {
    body = (await res.json()) as BeatMarketApiResponse
  } catch {
    return ERROR
  }
  return isValidMarketResponse(body) ? buildMarketState(request, body.data.amountOut) : IDLE
}

export function useBeatMarket(info: ReceiveAmountInfo | null): BeatMarketState {
  const [state, setState] = useState<BeatMarketState>(IDLE)

  const abortRef = useRef<AbortController | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const requestIdRef = useRef(0)

  const request = buildBeatMarketRequest(info)
  const signature = request ? request.signature : ''

  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current)
    abortRef.current?.abort()

    if (!request) {
      setState(IDLE)
      return
    }

    const id = ++requestIdRef.current
    setState((s) => ({ ...s, status: 'pending' }))

    timerRef.current = setTimeout(() => {
      const controller = new AbortController()
      abortRef.current = controller
      fetchBeatMarketState(request, controller.signal)
        .then((nextState) => {
          if (id === requestIdRef.current) setState(nextState)
        })
        .catch(() => {
          if (!controller.signal.aborted && id === requestIdRef.current) setState(ERROR)
        })
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
