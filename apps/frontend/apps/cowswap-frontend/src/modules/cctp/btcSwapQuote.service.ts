import {
  areAddressesEqual,
  getQuoteWithoutSigner,
  OrderBookApi,
  OrderKind,
  PriceQuality,
  type QuoteResults,
} from '@cowprotocol/cow-sdk'

import { WBTC_ETHEREUM } from 'entities/cctp'
import { formatUnits, getAddress } from 'viem'

import { type QuoteParams } from 'modules/tradeQuote'

import { parseCctpAmount, quoteCctp, type CctpQuote } from './cctp.service'
import { cctpToken } from './cctpAssets.const'

const ethereumOrderBook = new OrderBookApi({ chainId: 1, env: 'prod' })

export interface BtcSwapQuote {
  swap: QuoteResults
  bridge: CctpQuote
  quotedAt: number
}

export async function quoteBtcSwap(params: QuoteParams, owner: string, input: string): Promise<BtcSwapQuote> {
  const request = params.quoteParams
  const amount = parseCctpAmount(input, 'cirBTC')
  const account = getAddress(owner) as `0x${string}`
  const hooks = params.appData?.metadata?.hooks
  assertBtcRequest(request, owner, amount)
  if (hooks?.pre?.length || hooks?.post?.length) throw new Error('Remove custom hooks to use this route.')
  const { result: swap } = await getQuoteWithoutSigner(
    {
      kind: OrderKind.SELL,
      owner: account,
      receiver: account,
      amount: amount.toString(),
      sellToken: WBTC_ETHEREUM,
      sellTokenDecimals: 8,
      buyToken: cctpToken(1, 'cirBTC'),
      buyTokenDecimals: 8,
      partiallyFillable: false,
      validFor: 300,
      slippageBps: request.swapSlippageBps ?? 50,
      partnerFee: request.partnerFee,
    },
    { chainId: 1, account, appCode: request.appCode, env: 'prod' },
    { appData: params.appData, quoteRequest: { priceQuality: PriceQuality.OPTIMAL } },
    ethereumOrderBook,
  )
  assertBtcOrder(swap, account, amount)
  const order = swap.orderToSign
  // Check the bridge before spending WBTC. The fee is refreshed after the fill.
  const bridge = await quoteCctp(1, 5042, getAddress(owner), formatUnits(BigInt(order.buyAmount), 8), 'cirBTC')
  return { swap, bridge, quotedAt: Date.now() }
}

function assertBtcOrder(swap: QuoteResults, owner: string, amount: bigint): void {
  const order = swap.orderToSign
  if (
    ![
      areAddressesEqual(order.sellToken, WBTC_ETHEREUM),
      areAddressesEqual(order.buyToken, cctpToken(1, 'cirBTC')),
      areAddressesEqual(order.receiver, owner),
      order.kind === OrderKind.SELL,
      !order.partiallyFillable,
      BigInt(order.sellAmount) === amount,
      BigInt(order.feeAmount) === 0n,
      BigInt(order.buyAmount) * 100n >= amount * 95n,
    ].every(Boolean)
  )
    throw new Error('No acceptable WBTC → cirBTC quote. Try a smaller amount.')
}

function assertBtcRequest(
  request: QuoteParams['quoteParams'],
  owner: string,
  amount: bigint,
): asserts request is NonNullable<QuoteParams['quoteParams']> {
  if (!request) throw new Error('Enter an amount and review the route again.')
  const slippage = request.swapSlippageBps ?? 50
  if (
    ![
      request.amount === amount,
      request.kind === OrderKind.SELL,
      !request.partiallyFillable,
      request.sellTokenChainId === 1,
      Number(request.buyTokenChainId) === 5042,
      request.sellTokenDecimals === 8,
      request.buyTokenDecimals === 8,
      areAddressesEqual(request.owner, owner),
      !request.receiver || areAddressesEqual(request.receiver, owner),
      areAddressesEqual(request.sellTokenAddress, WBTC_ETHEREUM),
      areAddressesEqual(request.buyTokenAddress, cctpToken(5042, 'cirBTC')),
      Number.isInteger(slippage),
      slippage >= 0,
      slippage <= 500,
    ].every(Boolean)
  )
    throw new Error('Swap details changed or slippage exceeds 5%. Review the route again.')
}
