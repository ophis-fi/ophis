import { areAddressesEqual, EVM_NATIVE_CURRENCY_ADDRESS } from '@cowprotocol/cow-sdk'
import { Interface } from '@ethersproject/abi'
import { JsonRpcProvider } from '@ethersproject/providers'

import BigNumber from 'bignumber.js'

import { createQuoteRpc } from './quoteRpc.service'
import {
  directWrappedOutputToken,
  encodePath,
  isMpsSell,
  MPS,
  MPS_V2_PAIR,
  QUOTER,
  Route,
  USDC,
  WETH,
} from './router.service'

import type { DirectRequest } from './quote.service'

const quoter = new Interface([
  'function quoteExactInput(bytes,uint256) returns (uint256,uint160[],uint32[],uint256)',
  'function quoteExactOutput(bytes,uint256) returns (uint256,uint160[],uint32[],uint256)',
])
const pair = new Interface(['function getReserves() view returns (uint112,uint112,uint32)'])
const FEES = [100, 500, 3000, 10000]
// QuoterV2 uses TickMath.MIN_SQRT_RATIO + 1 / MAX_SQRT_RATIO - 1 as its swap limits.
const PRICE_LIMITS = ['4295128740', '1461446703485210103287273052203988822378723970341']
// MPS's three Ethereum pools: direct v3, USDC v3 (1%), and USDC v2.
// Compare each standard WETH/USDC v3 fee tier for the intermediate hop.
const ROUTES: Route[] = [
  ...FEES.map((fee) => ({ label: `Uniswap v3 (${fee / 10000}%)`, tokens: [WETH, MPS], fees: [fee] })),
  ...FEES.flatMap((fee) => [
    { label: 'Uniswap v3 via USDC', tokens: [WETH, USDC, MPS], fees: [fee, 10000] },
    { label: 'Uniswap v3 + v2 via USDC', tokens: [WETH, USDC], fees: [fee], viaV2: true },
  ]),
]

export async function gasConversionRate(market: Market, request: DirectRequest): Promise<bigint> {
  const token = isMpsSell(request) ? directWrappedOutputToken(request) : request.inputToken || WETH
  return areAddressesEqual(token, WETH)
    ? 10n ** 18n
    : quoteV3(market, { label: '', tokens: [WETH, token], fees: [500] }, 10n ** 18n, false)
}

export interface Market {
  inputPerEth: bigint
  approvalGas: bigint
  rpc: ReturnType<typeof createQuoteRpc>
  blockNumber: number
  timestamp: number
  baseFee: bigint
  priorityFee: bigint
  usdcReserve: bigint
  mpsReserve: bigint
}

export async function getMarket(provider: JsonRpcProvider, signal?: AbortSignal): Promise<Market> {
  const [block, priority] = await Promise.all([
    provider.getBlock('latest'),
    provider.send('eth_maxPriorityFeePerGas', []).catch(() => null) as Promise<string | null>,
  ])
  signal?.throwIfAborted()
  if (!block.baseFeePerGas) throw new Error('Gas estimate unavailable')
  const baseFee = BigInt(block.baseFeePerGas.toString())
  const tip = priority === null ? BigInt((await provider.getGasPrice()).toString()) - baseFee : BigInt(priority)
  const priorityFee = BigInt(BigNumber.maximum(tip.toString(), 0).toFixed())
  const reserves = await provider
    .call({ to: MPS_V2_PAIR, data: pair.encodeFunctionData('getReserves') }, block.number)
    .then((result) => pair.decodeFunctionResult('getReserves', result))
  // The immutable v2 pair sorts MPS (0x96...) before USDC (0xA0...).
  const usdcReserve = BigInt(String(reserves[1]))
  const mpsReserve = BigInt(String(reserves[0]))

  return {
    inputPerEth: 10n ** 18n,
    approvalGas: 0n,
    rpc: createQuoteRpc(provider, block.number, signal),
    blockNumber: block.number,
    timestamp: block.timestamp,
    baseFee,
    priorityFee,
    usdcReserve,
    mpsReserve,
  }
}

export async function quoteV3(
  market: Market,
  route: Route,
  amount: bigint,
  exactOutput: boolean,
  requireFullInput = false,
): Promise<bigint> {
  if (route.tokens.length === 1) return amount
  const method = exactOutput ? 'quoteExactOutput' : 'quoteExactInput'
  const result = await market.rpc.call(
    QUOTER,
    quoter.encodeFunctionData(method, [encodePath(route, exactOutput), amount]),
  )
  const [quotedAmount, prices] = quoter.decodeFunctionResult(method, result)
  // A boundary hit can leave MPS or intermediate USDC unspent; do not quote it as a full sale.
  if (requireFullInput && Array.from(prices, String).some((price) => PRICE_LIMITS.includes(price))) return 0n
  return BigInt(String(quotedAmount))
}

export function getRoutes(inputToken?: string, outputToken?: string): Route[] {
  if (
    isMpsSell({ inputToken }) &&
    outputToken &&
    ![WETH, EVM_NATIVE_CURRENCY_ADDRESS].some((token) => areAddressesEqual(token, outputToken))
  )
    return sellTokenRoutes(outputToken)
  if (isMpsSell({ inputToken }))
    return ROUTES.map((route) => ({
      ...route,
      label: route.viaV2 ? 'Uniswap v2 + v3 via USDC' : route.label,
      tokens: [...route.tokens].reverse(),
      fees: [...route.fees].reverse(),
    }))
  return inputToken
    ? [
        { label: 'Uniswap v3 USDC/MPS', tokens: [USDC, MPS], fees: [10000] },
        { label: 'Uniswap v2 USDC/MPS', tokens: [USDC], fees: [], viaV2: true },
        ...FEES.map((fee) => ({ label: 'Uniswap v3 via WETH', tokens: [USDC, WETH, MPS], fees: [fee, 10000] })),
      ]
    : ROUTES
}

function sellTokenRoutes(outputToken: string): Route[] {
  if (areAddressesEqual(outputToken, USDC))
    return [
      { label: 'Uniswap v2', tokens: [USDC], fees: [], viaV2: true },
      { label: 'Uniswap v3', tokens: [MPS, USDC], fees: [10000] },
      ...FEES.map((fee) => ({ label: 'Uniswap v3 via WETH', tokens: [MPS, WETH, USDC], fees: [10000, fee] })),
    ]
  return FEES.flatMap((fee) => [
    { label: 'Uniswap v2 + v3 via USDC', tokens: [USDC, outputToken], fees: [fee], viaV2: true },
    { label: 'Uniswap v3 via USDC', tokens: [MPS, USDC, outputToken], fees: [10000, fee] },
    { label: 'Uniswap v3 via WETH', tokens: [MPS, WETH, outputToken], fees: [10000, fee] },
  ])
}
