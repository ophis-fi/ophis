import { useAtomValue } from 'jotai'
import { useCallback, useEffect, useMemo, useState } from 'react'

import { useNativeTokenBalance } from '@cowprotocol/balances-and-allowances'
import { getRpcProvider, NATIVE_CURRENCY_ADDRESS } from '@cowprotocol/common-const'
import { useMachineTimeMs } from '@cowprotocol/common-hooks'
import { getCurrencyAddress, getIsNativeToken, isTruthy, withTimeout } from '@cowprotocol/common-utils'
import { areAddressesEqual, OrderKind } from '@cowprotocol/cow-sdk'
import { useIsSmartContractWallet, useWalletInfo } from '@cowprotocol/wallet'

import { atomWithQuery } from 'jotai-tanstack-query'
import { OPHIS_PARTNER_FEE_RECIPIENT } from 'ophis/partnerFeeDefault'

import { useQuoteParams, useTradeQuote } from 'modules/tradeQuote'
import { useSlippageConfig, useTradeSlippageValueAndType } from 'modules/tradeSlippage'
import { useUsdAmount } from 'modules/usdAmount'

import { useCowDepositGas } from './useCowDepositGas'
import { useDirectOutput } from './useDirectOutput'
import { useSwapDerivedState } from './useSwapDerivedState'
import { useSwapSettings } from './useSwapSettings'

import { GNOSIS_MPS, WXDAI } from '../services/wholeToken/gnosis.service'
import { isReplaceableCowPermit } from '../services/wholeToken/permitHook.service'
import { DirectRequest, getDirectQuotes } from '../services/wholeToken/quote.service'
import { directChainId, DirectQuote, MPS, USDC, VolumeFee } from '../services/wholeToken/router.service'
import { canFundDirect, comparisonLoading, selectDirect } from '../services/wholeToken/selection.service'

type SwapState = ReturnType<typeof useSwapDerivedState>
type QuoteParams = NonNullable<ReturnType<typeof useQuoteParams>>
function supportsDirect(state: SwapState): state is SwapState & {
  inputCurrency: NonNullable<SwapState['inputCurrency']>
  outputCurrency: NonNullable<SwapState['outputCurrency']>
} {
  const { inputCurrency, outputCurrency } = state
  if (!inputCurrency || !outputCurrency) return false
  if (inputCurrency.chainId === 100 && outputCurrency.chainId === 100) {
    return [
      state.orderKind === OrderKind.SELL,
      areAddressesEqual(getCurrencyAddress(inputCurrency), GNOSIS_MPS),
      getIsNativeToken(outputCurrency) || areAddressesEqual(getCurrencyAddress(outputCurrency), WXDAI),
    ].every(Boolean)
  }
  const buying =
    (getIsNativeToken(inputCurrency) || areAddressesEqual(getCurrencyAddress(inputCurrency), USDC)) &&
    areAddressesEqual(getCurrencyAddress(outputCurrency), MPS)
  const selling = areAddressesEqual(getCurrencyAddress(inputCurrency), MPS) && getIsNativeToken(outputCurrency)
  return [
    state.orderKind === OrderKind.SELL,
    buying || selling,
    inputCurrency.chainId === 1,
    outputCurrency.chainId === 1,
  ].every(Boolean)
}
function getFees(params: QuoteParams): VolumeFee[] | null {
  const metadata = params.appData?.metadata
  if (!metadata) return null
  const customPreHooks = metadata.hooks?.pre?.filter(
    (hook) => !isReplaceableCowPermit(hook, params.quoteParams?.sellTokenAddress),
  )
  if ([customPreHooks?.length, metadata.hooks?.post?.length].some(Boolean)) return null
  const entries = [metadata.partnerFee].flat().filter(isTruthy)
  // Ophis's CoW auction-improvement fee is inapplicable to a direct AMM quote.
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
  const inputToken = directInput(state)
  const outputToken = getCurrencyAddress(state.outputCurrency)
  const chainId = requestChain(state)
  if (!recipient || !fees || !matchesForm(q, budget, account, recipient, inputToken, chainId, outputToken)) return null
  return {
    inputToken,
    outputToken,
    chainId,
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
  inputToken?: string,
  chainId: 1 | 100 = 1,
  outputToken?: string,
): boolean {
  return [
    q.amount.toString() === budget,
    q.kind === OrderKind.SELL,
    q.sellTokenChainId === chainId,
    areAddressesEqual(q.sellTokenAddress, inputToken || NATIVE_CURRENCY_ADDRESS),
    q.buyTokenChainId === chainId,
    areAddressesEqual(q.buyTokenAddress, outputToken),
    areAddressesEqual(q.owner, account || q.owner),
    areAddressesEqual(q.receiver || q.owner, recipient),
  ].every(Boolean)
}
function isDirectPending(
  result: { isPending: boolean; isFetching: boolean; isError: boolean; data?: DirectQuote[] },
  now: number,
): boolean {
  const best = result.isError ? undefined : result.data?.[0]
  return result.isPending || (result.isFetching && (!best || now - best.quotedAt >= 30000))
}
type Selection = { quote: DirectQuote | null; key: string } | null
function reviewedForKey(selection: Selection, key: string): DirectQuote | null {
  return selection?.key === key ? selection.quote : null
}
function getRequestKey(request: DirectRequest | null, isSmartWallet: boolean | undefined, chainId: number): string {
  return request && !isSmartWallet && chainId === (request.chainId ?? 1)
    ? JSON.stringify({ ...request, budget: request.budget.toString() })
    : ''
}
interface WholeTokenRouteState {
  quote: Awaited<ReturnType<typeof getDirectQuotes>>[number] | undefined
  output: ReturnType<typeof useSwapDerivedState>['outputCurrencyAmount']
  fiat: ReturnType<typeof useUsdAmount>['value']
  requestKey: string
  reviewed: boolean
  loading: boolean
  comparisonFailed: boolean
  refresh: () => Promise<unknown>
  review: (quote: DirectQuote | null) => void
}
export function useWholeTokenRoute(): WholeTokenRouteState {
  const [selection, setSelection] = useState<Selection>(null)
  const state = useSwapDerivedState()
  const params = useQuoteParams(state.inputCurrencyAmount?.quotient.toString())
  const { account, chainId } = useWalletInfo()
  const { data: nativeBalance } = useNativeTokenBalance(account, chainId)
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
        queryFn: async ({ signal }) => {
          const parsed = JSON.parse(requestKey) as Omit<DirectRequest, 'budget'> & { budget: string }
          const controller = new AbortController()
          const abort = (): void => controller.abort()
          signal.addEventListener('abort', abort, { once: true })
          if (signal.aborted) abort()
          const timer = setTimeout(abort, 20000)
          try {
            return await withTimeout(fetchDirectQuotes(parsed, controller.signal), 20000)
          } finally {
            abort()
            clearTimeout(timer)
            signal.removeEventListener('abort', abort)
          }
        },
        refetchInterval: 20000,
        retry: 1,
        retryDelay: 1000,
        staleTime: 10000,
      })),
    [requestKey, isReviewing],
  )
  const result = useAtomValue(queryAtom)
  const cow = useTradeQuote()
  const { gas: depositGas, loading: gasLoading } = useCowDepositGas(
    depositQuote(requestKey, request, cow.quote),
    request?.account,
  )
  const best =
    requestKey && !result.isError
      ? result.data?.find((candidate) =>
          canFundDirect(candidate, !!account, nativeBalance ? BigInt(nativeBalance.toString()) : undefined),
        )
      : undefined
  const now = useMachineTimeMs(1000)
  const loading = comparisonLoading(requestKey, isReviewing, isDirectPending(result, now), cow, gasLoading)
  const quote = reviewed || (loading ? undefined : selectDirect(best, cow, now, depositGas))
  const review = useCallback((quote: DirectQuote | null) => setSelection({ quote, key: requestKey }), [requestKey])
  const output = useDirectOutput(quote, state.outputCurrency)
  const { value: fiat } = useUsdAmount(output)
  const comparisonFailed = !!requestKey && result.isError
  return useMemo(
    () => ({
      quote,
      output,
      fiat,
      requestKey,
      reviewed: !!reviewed,
      review,
      loading,
      comparisonFailed,
      refresh: result.refetch,
    }),
    [quote, output, fiat, requestKey, reviewed, review, loading, comparisonFailed, result.refetch],
  )
}
function directInput(state: SwapState): string | undefined {
  return state.inputCurrency && !getIsNativeToken(state.inputCurrency)
    ? getCurrencyAddress(state.inputCurrency)
    : undefined
}
function depositQuote(
  key: string,
  request: DirectRequest | null,
  quote: ReturnType<typeof useTradeQuote>['quote'],
): ReturnType<typeof useTradeQuote>['quote'] {
  return key && !request?.inputToken ? quote : null
}
function requestChain(state: SwapState): 1 | 100 {
  return state.inputCurrency?.chainId === 100 ? 100 : 1
}
function fetchDirectQuotes(
  parsed: Omit<DirectRequest, 'budget'> & { budget: string },
  signal: AbortSignal,
): Promise<DirectQuote[]> {
  return getDirectQuotes(getRpcProvider(directChainId(parsed)), { ...parsed, budget: BigInt(parsed.budget) }, signal)
}
