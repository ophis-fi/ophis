import { getAddress } from '@ethersproject/address'
import { JsonRpcProvider } from '@ethersproject/providers'

import BigNumber from 'bignumber.js'

import { getGnosisQuotes } from './gnosisQuote.service'
import { getInputApprovals, simulationState } from './input.service'
import { getMarket, getRoutes, Market, quoteV3 } from './market.service'
import { unavailableRoute } from './quoteRpc.service'
import {
  directChainId,
  buildDirectTransaction,
  DirectQuote,
  isMpsSell,
  Route,
  USDC,
  VolumeFee,
  WETH,
} from './router.service'
import { quoteMpsSell } from './sell.service'

export interface DirectRequest {
  chainId?: 1 | 100
  inputToken?: string
  outputToken?: string
  account: string
  recipient: string
  budget: bigint
  deadlineSeconds?: number
  slippageBps: number
  fees: VolumeFee[]
}

function getDeadlineSeconds(deadline = 300): number {
  if (!Number.isSafeInteger(deadline) || deadline <= 0) throw new Error('Invalid deadline')
  return deadline
}

export async function getDirectQuotes(
  provider: JsonRpcProvider,
  request: DirectRequest,
  signal?: AbortSignal,
): Promise<DirectQuote[]> {
  signal?.throwIfAborted()
  validateRequest(request)
  if ((await provider.getNetwork()).chainId !== directChainId(request)) throw new Error('Switch to the quoted network')
  if (request.chainId === 100) return getGnosisQuotes(provider, request, signal)
  signal?.throwIfAborted()
  // Require funded simulation on this read RPC; never mix fork and public state.
  await provider.send('eth_estimateGas', [
    { from: request.account, to: WETH, value: '0x1' },
    'latest',
    { [request.account]: { balance: '0x3635c9adc5dea00000' } },
  ])
  signal?.throwIfAborted()
  const market = await getMarket(provider, signal)
  market.rpc.check()
  const approvals = request.inputToken
    ? await getInputApprovals(
        provider,
        request.account,
        request.budget,
        market.timestamp + getDeadlineSeconds(request.deadlineSeconds),
        request.inputToken,
      )
    : []
  market.rpc.check()
  const approvalGas = await Promise.all(
    approvals.map(async (tx) =>
      BigInt(
        await provider.send('eth_estimateGas', [
          { ...tx, from: request.account },
          'latest',
          simulationState(request.account),
        ]),
      ),
    ),
  )
  market.approvalGas = approvalGas.reduce((sum, gas) => sum + gas, 0n)
  if (request.inputToken && !isMpsSell(request))
    market.inputPerEth = await quoteV3(market, { label: '', tokens: [WETH, USDC], fees: [500] }, 10n ** 18n, false)
  const results = await Promise.all(
    getRoutes(request.inputToken).map((route) =>
      (isMpsSell(request)
        ? quoteMpsSell(provider, request, market, route)
        : quoteRoute(provider, request, market, route)
      ).catch(unavailableRoute),
    ),
  )
  signal?.throwIfAborted()
  return results
    .flatMap((result) => (result ? [result] : []))
    .sort((a, b) =>
      isMpsSell(request)
        ? a.buyAmount - a.gasCost > b.buyAmount - b.gasCost
          ? -1
          : 1
        : a.buyAmount !== b.buyAmount
          ? a.buyAmount > b.buyAmount
            ? -1
            : 1
          : a.netCost < b.netCost
            ? -1
            : 1,
    )
}

async function forAmount(
  provider: JsonRpcProvider,
  request: DirectRequest,
  market: Market,
  route: Route,
  buyAmount: bigint,
  estimatedGas?: bigint,
): Promise<DirectQuote | null> {
  market.rpc.check()
  const { usdcReserve, mpsReserve, baseFee, priorityFee } = market
  if (route.viaV2 && [buyAmount >= mpsReserve, !usdcReserve].some(Boolean)) return null
  const usdcRequired = route.viaV2 ? (usdcReserve * buyAmount * 1000n) / ((mpsReserve - buyAmount) * 997n) + 1n : 0n
  // Split the mixed-route tolerance across both legs, retaining the overall ETH cap.
  const usdcAmount = (usdcRequired * BigInt(20000 + request.slippageBps) + 19999n) / 20000n
  const baseInput = await quoteV3(market, route, route.viaV2 ? usdcRequired : buyAmount, true)
  const sellAmount = route.viaV2 && route.tokens.length > 1 ? await quoteV3(market, route, usdcAmount, true) : baseInput
  const maxInput = (baseInput * BigInt(10000 + request.slippageBps) + 9999n) / 10000n
  const fees = request.fees.map((fee) => ({
    recipient: fee.recipient,
    amount: BigInt(
      new BigNumber(sellAmount.toString()).times(fee.bps).div(10000).integerValue(BigNumber.ROUND_CEIL).toFixed(0),
    ),
  }))
  const feeTotal = fees.reduce((sum, fee) => sum + fee.amount, 0n)
  if (maxInput + feeTotal >= request.budget) return null
  const quote: DirectQuote = {
    ...request,
    route,
    buyAmount,
    sellAmount,
    maxInput,
    usdcAmount: route.tokens.length === 1 ? maxInput : usdcAmount,
    usdcRefund: route.tokens.length === 1 ? 0n : usdcAmount - usdcRequired,
    approvalGas: market.approvalGas,
    needsApproval: market.approvalGas > 0n,
    netCost: 0n,
    fees,
    gasLimit: 0n,
    gasCost: 0n,
    maxFeePerGas: baseFee * 2n + priorityFee,
    maxPriorityFeePerGas: priorityFee,
    totalCost: 0n,
    maxTotal: maxInput + feeTotal,
    quotedAt: Date.now(),
    expiresAt: market.timestamp + getDeadlineSeconds(request.deadlineSeconds),
  }
  return finishQuote(provider, market, quote, estimatedGas)
}

async function finishQuote(
  provider: JsonRpcProvider,
  market: Market,
  quote: DirectQuote,
  estimatedGas?: bigint,
): Promise<DirectQuote> {
  const feeTotal = quote.fees.reduce((sum, fee) => sum + fee.amount, 0n)
  const route = quote.route
  const tx = buildDirectTransaction(quote)
  const simulation = [
    {
      from: tx.from,
      to: tx.to,
      data: tx.data,
      value: `0x${(quote.inputToken ? 0n : quote.maxInput + feeTotal).toString(16)}`,
    },
    `0x${market.blockNumber.toString(16)}`,
    simulationState(quote.account, quote.inputToken),
  ]
  const { baseFee, priorityFee } = market
  const gas = estimatedGas ?? BigInt(await provider.send('eth_estimateGas', simulation))
  market.rpc.check()
  quote.gasLimit = (gas * 120n + 99n) / 100n
  quote.gasCost = gas * (baseFee + priorityFee)
  quote.gasCostInInput =
    ((gas + market.approvalGas) * (baseFee + priorityFee) * market.inputPerEth + 10n ** 18n - 1n) / 10n ** 18n
  quote.totalCost = quote.sellAmount + feeTotal + quote.gasCostInInput
  const refundValue =
    quote.usdcRefund > 0n ? await quoteV3(market, { ...route, tokens: [USDC, WETH] }, quote.usdcRefund, false) : 0n
  quote.netCost = quote.totalCost - refundValue
  quote.maxTotal = quote.maxInput + feeTotal + (quote.inputToken ? 0n : quote.gasLimit * quote.maxFeePerGas)
  return quote
}

async function quoteRoute(
  provider: JsonRpcProvider,
  request: DirectRequest,
  market: Market,
  route: Route,
): Promise<DirectQuote | null> {
  const { usdcReserve, mpsReserve } = market
  const capacity = await quoteV3(market, route, request.budget, false)
  const maximum = route.viaV2 ? (capacity * 997n * mpsReserve) / (usdcReserve * 1000n + capacity * 997n) : capacity
  if (maximum <= 0n) return null
  const seed = await forAmount(provider, request, market, route, 1n)
  if (!seed || seed.maxTotal > request.budget) return null
  const candidate = await findAffordable(provider, request, market, route, maximum, (seed.gasLimit * 100n) / 120n)
  market.rpc.check()
  if (!candidate) return seed
  if (candidate.buyAmount === seed.buyAmount) return seed
  const verified = await forAmount(provider, request, market, route, candidate.buyAmount).catch(unavailableRoute)
  if (verified && verified.maxTotal <= request.budget) return verified
  // If tick crossings or transfer rules invalidate the estimate, search below
  // that candidate with actual simulations instead of discarding the route.
  return (await findAffordable(provider, request, market, route, candidate.buyAmount - 1n)) || seed
}

async function findAffordable(
  provider: JsonRpcProvider,
  request: DirectRequest,
  market: Market,
  route: Route,
  maximum: bigint,
  estimatedGas?: bigint,
  low = 2n,
  best: DirectQuote | null = null,
): Promise<DirectQuote | null> {
  market.rpc.check()
  if (low > maximum) return best
  const middle = (low + maximum) / 2n
  const quote = await forAmount(provider, request, market, route, middle, estimatedGas).catch(unavailableRoute)
  return quote && quote.maxTotal <= request.budget
    ? findAffordable(provider, request, market, route, maximum, estimatedGas, middle + 1n, quote)
    : findAffordable(provider, request, market, route, middle - 1n, estimatedGas, low, best)
}

function validateRequest(request: DirectRequest): void {
  getDeadlineSeconds(request.deadlineSeconds)
  getAddress(request.account)
  getAddress(request.recipient)
  if (
    request.budget <= 0n ||
    !Number.isInteger(request.slippageBps) ||
    request.slippageBps < 0 ||
    request.slippageBps > 5000
  ) {
    throw new Error('Invalid amount or slippage')
  }
  for (const fee of request.fees) {
    getAddress(fee.recipient)
    if (!Number.isFinite(fee.bps) || fee.bps < 0 || fee.bps > 10000) throw new Error('Invalid fee')
  }
}
