import { areAddressesEqual } from '@cowprotocol/cow-sdk'
import { Interface } from '@ethersproject/abi'
import { getAddress } from '@ethersproject/address'
import { JsonRpcProvider } from '@ethersproject/providers'

import BigNumber from 'bignumber.js'

import {
  buildDirectTransaction,
  DirectQuote,
  encodePath,
  MPS,
  MPS_V2_PAIR,
  QUOTER,
  Route,
  USDC,
  VolumeFee,
  WETH,
} from './router.service'

const quoter = new Interface([
  'function quoteExactInput(bytes,uint256) returns (uint256,uint160[],uint32[],uint256)',
  'function quoteExactOutput(bytes,uint256) returns (uint256,uint160[],uint32[],uint256)',
])
const pair = new Interface([
  'function getReserves() view returns (uint112,uint112,uint32)',
  'function token0() view returns (address)',
])
const FEES = [100, 500, 3000, 10000]
// MPS's three Ethereum pools: direct v3, USDC v3 (1%), and USDC v2.
// Compare each standard WETH/USDC v3 fee tier for the intermediate hop.
const ROUTES: Route[] = [
  ...FEES.map((fee) => ({ label: `Uniswap v3 (${fee / 10000}%)`, tokens: [WETH, MPS], fees: [fee] })),
  ...FEES.flatMap((fee) => [
    { label: 'Uniswap v3 via USDC', tokens: [WETH, USDC, MPS], fees: [fee, 10000] },
    { label: 'Uniswap v3 + v2 via USDC', tokens: [WETH, USDC], fees: [fee], viaV2: true },
  ]),
]

export interface DirectRequest {
  account: string
  recipient: string
  budget: bigint
  slippageBps: number
  fees: VolumeFee[]
}

export async function getDirectQuotes(provider: JsonRpcProvider, request: DirectRequest): Promise<DirectQuote[]> {
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
  if ((await provider.getNetwork()).chainId !== 1) throw new Error('Switch to Ethereum')
  const market = await getMarket(provider)
  const results = await Promise.allSettled(ROUTES.map((route) => quoteRoute(provider, request, market, route)))
  return results
    .flatMap((result) => (result.status === 'fulfilled' && result.value ? [result.value] : []))
    .sort((a, b) =>
      a.buyAmount !== b.buyAmount ? (a.buyAmount > b.buyAmount ? -1 : 1) : a.netCost < b.netCost ? -1 : 1,
    )
}

interface Market {
  blockNumber: number
  baseFee: bigint
  priorityFee: bigint
  usdcReserve: bigint
  mpsReserve: bigint
}

async function getMarket(provider: JsonRpcProvider): Promise<Market> {
  const [block, priority] = await Promise.all([
    provider.getBlock('latest'),
    provider.send('eth_maxPriorityFeePerGas', []) as Promise<string>,
  ])
  if (!block.baseFeePerGas) throw new Error('Gas estimate unavailable')
  const priorityFee = BigInt(priority)
  const baseFee = BigInt(block.baseFeePerGas.toString())
  const reserveResult = await Promise.allSettled([
    provider.call({ to: MPS_V2_PAIR, data: pair.encodeFunctionData('getReserves') }, block.number),
    provider.call({ to: MPS_V2_PAIR, data: pair.encodeFunctionData('token0') }, block.number),
  ])
  const reserves =
    reserveResult[0].status === 'fulfilled' && reserveResult[1].status === 'fulfilled'
      ? pair.decodeFunctionResult('getReserves', reserveResult[0].value)
      : null
  const usdcFirst =
    reserveResult[1].status === 'fulfilled' &&
    areAddressesEqual(String(pair.decodeFunctionResult('token0', reserveResult[1].value)[0]), USDC)
  const usdcReserve = reserves ? BigInt(String(reserves[usdcFirst ? 0 : 1])) : 0n
  const mpsReserve = reserves ? BigInt(String(reserves[usdcFirst ? 1 : 0])) : 0n

  return { blockNumber: block.number, baseFee, priorityFee, usdcReserve, mpsReserve }
}

async function quoteV3(
  provider: JsonRpcProvider,
  blockNumber: number,
  route: Route,
  amount: bigint,
  exactOutput: boolean,
): Promise<bigint> {
  const method = exactOutput ? 'quoteExactOutput' : 'quoteExactInput'
  const result = await provider.call(
    { to: QUOTER, data: quoter.encodeFunctionData(method, [encodePath(route, exactOutput), amount]) },
    blockNumber,
  )
  return BigInt(String(quoter.decodeFunctionResult(method, result)[0]))
}

async function forAmount(
  provider: JsonRpcProvider,
  request: DirectRequest,
  market: Market,
  route: Route,
  buyAmount: bigint,
  estimatedGas?: bigint,
): Promise<DirectQuote | null> {
  const { usdcReserve, mpsReserve, baseFee, priorityFee, blockNumber } = market
  if (route.viaV2 && [buyAmount >= mpsReserve, !usdcReserve].some(Boolean)) return null
  const usdcRequired = route.viaV2 ? (usdcReserve * buyAmount * 1000n) / ((mpsReserve - buyAmount) * 997n) + 1n : 0n
  // Split the mixed-route tolerance across both legs, retaining the overall ETH cap.
  const usdcAmount = (usdcRequired * BigInt(20000 + request.slippageBps) + 19999n) / 20000n
  const baseInput = await quoteV3(provider, blockNumber, route, route.viaV2 ? usdcRequired : buyAmount, true)
  const sellAmount = route.viaV2 ? await quoteV3(provider, blockNumber, route, usdcAmount, true) : baseInput
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
    usdcAmount,
    usdcRefund: usdcAmount - usdcRequired,
    netCost: 0n,
    fees,
    gasLimit: 0n,
    gasCost: 0n,
    maxFeePerGas: baseFee * 2n + priorityFee,
    maxPriorityFeePerGas: priorityFee,
    totalCost: 0n,
    maxTotal: maxInput + feeTotal,
    quotedAt: Date.now(),
    expiresAt: Math.floor(Date.now() / 1000) + 300,
  }
  const tx = buildDirectTransaction(quote)
  const gas =
    estimatedGas ??
    BigInt(
      await provider
        .send('eth_estimateGas', [
          {
            from: tx.from,
            to: tx.to,
            data: tx.data,
            value: `0x${(maxInput + feeTotal).toString(16)}`,
          },
          `0x${blockNumber.toString(16)}`,
          { [request.account]: { balance: '0x3635c9adc5dea00000' } },
        ])
        .catch(async () => (await provider.estimateGas({ ...tx, gasLimit: undefined })).toString()),
    )
  quote.gasLimit = (gas * 120n + 99n) / 100n
  quote.gasCost = gas * (baseFee + priorityFee)
  quote.totalCost = sellAmount + feeTotal + quote.gasCost
  const refundValue =
    quote.usdcRefund > 0n
      ? await quoteV3(provider, blockNumber, { ...route, tokens: [USDC, WETH] }, quote.usdcRefund, false)
      : 0n
  quote.netCost = quote.totalCost - refundValue
  quote.maxTotal = maxInput + feeTotal + quote.gasLimit * quote.maxFeePerGas
  return quote.maxTotal <= request.budget ? quote : null
}

async function quoteRoute(
  provider: JsonRpcProvider,
  request: DirectRequest,
  market: Market,
  route: Route,
): Promise<DirectQuote | null> {
  const { usdcReserve, mpsReserve } = market
  const capacity = await quoteV3(provider, market.blockNumber, route, request.budget, false)
  const maximum = route.viaV2 ? (capacity * 997n * mpsReserve) / (usdcReserve * 1000n + capacity * 997n) : capacity
  if (maximum <= 0n) return null
  const seed = await forAmount(provider, request, market, route, 1n)
  if (!seed || maximum === 1n) return seed
  // Integer search avoids losing a whole token to conservative gas reservation.
  let low = 2n
  let high = maximum
  let best = seed
  while (low <= high) {
    const middle = (low + high) / 2n
    const quote = await forAmount(provider, request, market, route, middle, (seed.gasLimit * 100n) / 120n)
    if (quote) {
      best = quote
      low = middle + 1n
    } else {
      high = middle - 1n
    }
  }
  // Reuse the seed's gas for search probes, then simulate the chosen transaction.
  if (best.buyAmount === 1n) return seed
  return (
    (await forAmount(provider, request, market, route, best.buyAmount)) ??
    (await forAmount(provider, request, market, route, best.buyAmount - 1n))
  )
}
