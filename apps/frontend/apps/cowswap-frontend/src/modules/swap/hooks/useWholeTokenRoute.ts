import { useAtomValue } from 'jotai'
import { useCallback, useEffect, useMemo, useState } from 'react'

import { getRpcProvider, NATIVE_CURRENCY_ADDRESS } from '@cowprotocol/common-const'
import { useMachineTimeMs } from '@cowprotocol/common-hooks'
import { getCurrencyAddress, getIsNativeToken, isTruthy, withTimeout } from '@cowprotocol/common-utils'
import { areAddressesEqual, OrderKind } from '@cowprotocol/cow-sdk'
import { CurrencyAmount } from '@cowprotocol/currency'
import { useIsSmartContractWallet, useWalletInfo } from '@cowprotocol/wallet'

import { atomWithQuery } from 'jotai-tanstack-query'
import { OPHIS_PARTNER_FEE_RECIPIENT } from 'ophis/partnerFeeDefault'

import { useQuoteParams, useTradeQuote } from 'modules/tradeQuote'
import { useSlippageConfig, useTradeSlippageValueAndType } from 'modules/tradeSlippage'
import { useUsdAmount } from 'modules/usdAmount'

import { useCowDepositGas } from './useCowDepositGas'
import { useSwapDerivedState } from './useSwapDerivedState'
import { useSwapSettings } from './useSwapSettings'

import { DirectRequest, getDirectQuotes } from '../services/wholeToken/quote.service'
import { DirectQuote, MPS, VolumeFee } from '../services/wholeToken/router.service'

type SwapState = ReturnType<typeof useSwapDerivedState>
type QuoteParams = NonNullable<ReturnType<typeof useQuoteParams>>
function supportsDirect(state: SwapState): boolean {
  const { inputCurrency, outputCurrency } = state
  if (!inputCurrency || !outputCurrency) return false
  return [
    state.orderKind === OrderKind.SELL,
    getIsNativeToken(inputCurrency),
    inputCurrency.chainId === 1,
    outputCurrency.chainId === 1,
    areAddressesEqual(getCurrencyAddress(outputCurrency), MPS),
  ].every(Boolean)
}
function getFees(params: QuoteParams): VolumeFee[] | null {
  const metadata = params.appData?.metadata
  if (!metadata) return null
  if ([metadata.hooks?.pre?.length, metadata.hooks?.post?.length].some(Boolean)) return null
  const entries = [metadata.partnerFee].flat().filter(isTruthy)
  // Ophis's CoW auction-improvement fee is inapplicable to a fixed-output AMM quote.
  const volume = entries.filter((fee) => 'volumeBps' in fee)
  const auction = entries.filter(
    (fee) => 'priceImprovementBps' in fee && areAddressesEqual(fee.recipient, OPHIS_PARTNER_FEE_RECIPIENT),
  )
  if (volume.length + auction.length !== entries.length) return null
  return volume.map((fee) => ({ recipient: fee.recipient, bps: fee.volumeBps }))
}
function getRequest(
  state: SwapState,
  params: QuoteParams | undefined,
  account: string | undefined,
  slippage: ReturnType<typeof useTradeSlippageValueAndType>,
  defaultSlippage: number,
  deadlineSeconds: number,
): DirectRequest | null {
  if (!params || !supportsDirect(state)) return null
  const q = params.quoteParams
  const budget = state.inputCurrencyAmount?.quotient.toString()
  if (!q?.owner || !budget) return null
  const recipient = resolveRecipient(state, account, q.owner)
  const fees = getFees(params)
  if (!recipient || !fees || !matchesForm(q, budget, account, recipient)) return null
  return {
    account: q.owner,
    recipient,
    budget: BigInt(budget),
    deadlineSeconds,
    slippageBps: getSlippage(slippage, defaultSlippage),
    fees,
  }
}
function getSlippage(slippage: ReturnType<typeof useTradeSlippageValueAndType>, fallback: number): number {
  return slippage.type === 'user' ? slippage.value : fallback
}
function resolveRecipient(state: SwapState, account: string | undefined, owner: string): string | null | undefined {
  return state.recipient ? state.recipientAddress : account || owner
}
function matchesForm(
  q: NonNullable<QuoteParams['quoteParams']>,
  budget: string,
  account: string | undefined,
  recipient: string,
): boolean {
  return [
    q.amount.toString() === budget,
    q.kind === OrderKind.SELL,
    q.sellTokenChainId === 1,
    areAddressesEqual(q.sellTokenAddress, NATIVE_CURRENCY_ADDRESS),
    q.buyTokenChainId === 1,
    areAddressesEqual(q.buyTokenAddress, MPS),
    areAddressesEqual(q.owner, account || q.owner),
    areAddressesEqual(q.receiver || q.owner, recipient),
  ].every(Boolean)
}
function selectDirect(
  best: DirectQuote | undefined,
  cow: ReturnType<typeof useTradeQuote>,
  now: number,
  depositGas: bigint,
): DirectQuote | undefined {
  if (!best || now - best.quotedAt >= 30000) return undefined
  if (cow.error || !cow.quote) return best
  const params = cow.quote.quoteResults.tradeParameters
  const changed = [
    !areAddressesEqual(params.sellToken, NATIVE_CURRENCY_ADDRESS),
    !areAddressesEqual(params.buyToken, MPS),
    params.amount !== best.budget.toString(),
  ].some(Boolean)
  if (changed) return undefined
  const amounts = cow.quote.quoteResults.amountsAndCosts
  return best.buyAmount > amounts.afterPartnerFees.buyAmount ||
    (best.buyAmount === amounts.afterPartnerFees.buyAmount &&
      best.netCost <
        amounts.amountsToSign.sellAmount + depositGas * ((best.maxFeePerGas + best.maxPriorityFeePerGas) / 2n))
    ? best
    : undefined
}
function isDirectPending(
  result: { isPending: boolean; isFetching: boolean; isError: boolean; data?: DirectQuote[] },
  now: number,
): boolean {
  const best = result.isError ? undefined : result.data?.[0]
  return result.isPending || (result.isFetching && (!best || now - best.quotedAt >= 30000))
}
function comparisonLoading(
  key: string,
  isReviewing: boolean,
  directPending: boolean,
  cow: ReturnType<typeof useTradeQuote>,
  gasPending: boolean,
): boolean {
  return (
    !!key && !isReviewing && (directPending || cow.isLoading || cow.hasParamsChanged || !cow.fetchParams || gasPending)
  )
}
type Selection = { quote: DirectQuote | null; key: string } | null
function reviewedForKey(selection: Selection, key: string): DirectQuote | null {
  return selection?.key === key ? selection.quote : null
}
function getRequestKey(request: DirectRequest | null, isSmartWallet: boolean | undefined, chainId: number): string {
  return request && !isSmartWallet && chainId === 1
    ? JSON.stringify({ ...request, budget: request.budget.toString() })
    : ''
}
export function useWholeTokenRoute(): {
  quote: Awaited<ReturnType<typeof getDirectQuotes>>[number] | undefined
  output: ReturnType<typeof useSwapDerivedState>['outputCurrencyAmount']
  fiat: ReturnType<typeof useUsdAmount>['value']
  requestKey: string
  reviewed: boolean
  loading: boolean
  review: (quote: DirectQuote | null) => void
} {
  const [selection, setSelection] = useState<Selection>(null)
  const state = useSwapDerivedState()
  const params = useQuoteParams(state.inputCurrencyAmount?.quotient.toString())
  const { account, chainId } = useWalletInfo()
  const isSmartWallet = useIsSmartContractWallet()
  const slippage = useTradeSlippageValueAndType()
  const config = useSlippageConfig()
  const { deadline } = useSwapSettings()
  const request = getRequest(state, params, account, slippage, config.defaultValue, deadline)
  const requestKey = getRequestKey(request, !!account && isSmartWallet !== false, chainId)
  useEffect(() => setSelection(null), [requestKey])
  const reviewed = reviewedForKey(selection, requestKey)
  const isReviewing = !!reviewed
  const queryAtom = useMemo(
    () =>
      atomWithQuery(() => ({
        queryKey: ['wholeTokenRoutes', requestKey],
        enabled: !!requestKey && !isReviewing,
        queryFn: async () => {
          const parsed = JSON.parse(requestKey) as Omit<DirectRequest, 'budget'> & { budget: string }
          return withTimeout(getDirectQuotes(getRpcProvider(1), { ...parsed, budget: BigInt(parsed.budget) }), 20000)
        },
        refetchInterval: 15000,
        retry: false,
        staleTime: 10000,
      })),
    [requestKey, isReviewing],
  )
  const result = useAtomValue(queryAtom)
  const cow = useTradeQuote()
  const { gas: depositGas, loading: gasLoading } = useCowDepositGas(requestKey ? cow.quote : null, request?.account)
  const best = requestKey && !result.isError ? result.data?.[0] : undefined
  const now = useMachineTimeMs(1000)
  const loading = comparisonLoading(requestKey, isReviewing, isDirectPending(result, now), cow, gasLoading)
  const quote = reviewed || (loading ? undefined : selectDirect(best, cow, now, depositGas))
  const review = useCallback((quote: DirectQuote | null) => setSelection({ quote, key: requestKey }), [requestKey])
  const output = useMemo(
    () =>
      quote && state.outputCurrency
        ? CurrencyAmount.fromRawAmount(state.outputCurrency, quote.buyAmount.toString())
        : null,
    [quote, state.outputCurrency],
  )
  const { value: fiat } = useUsdAmount(output)
  return useMemo(
    () => ({ quote, output, fiat, requestKey, reviewed: !!reviewed, review, loading }),
    [quote, output, fiat, requestKey, reviewed, review, loading],
  )
}
