import { JsonRpcProvider } from '@ethersproject/providers'

import BigNumber from 'bignumber.js'

import { simulationState } from './input.service'
import { Market, quoteV3 } from './market.service'
import { buildDirectTransaction, DirectQuote, Route } from './router.service'

import type { DirectRequest } from './quote.service'

export async function quoteMpsSell(
  provider: JsonRpcProvider,
  request: DirectRequest,
  market: Market,
  route: Route,
): Promise<DirectQuote | null> {
  const { budget } = request
  const intermediate = route.viaV2
    ? (budget * 997n * market.usdcReserve) / (market.mpsReserve * 1000n + budget * 997n)
    : budget
  if (intermediate <= 0n) return null
  const gross = await quoteV3(market, route, intermediate, false, true)
  // Fees are paid in WETH from output, so a 1 MPS sale never needs fractional MPS.
  const fees = request.fees.map((fee) => ({
    recipient: fee.recipient,
    amount: BigInt(
      new BigNumber(gross.toString()).times(fee.bps).div(10000).integerValue(BigNumber.ROUND_CEIL).toFixed(0),
    ),
  }))
  const buyAmount = gross - fees.reduce((sum, fee) => sum + fee.amount, 0n)
  const minBuyAmount = (buyAmount * BigInt(10000 - request.slippageBps)) / 10000n
  if (minBuyAmount <= 0n) return null
  const quote: DirectQuote = {
    ...request,
    route,
    fees,
    buyAmount,
    minBuyAmount,
    sellAmount: budget,
    maxInput: budget,
    maxTotal: budget,
    totalCost: budget,
    netCost: budget,
    usdcAmount: intermediate,
    usdcRefund: 0n,
    approvalGas: market.approvalGas,
    needsApproval: market.approvalGas > 0n,
    gasLimit: 0n,
    gasCost: 0n,
    gasCostInInput: 0n,
    maxFeePerGas: market.baseFee * 2n + market.priorityFee,
    maxPriorityFeePerGas: market.priorityFee,
    quotedAt: Date.now(),
    expiresAt: market.timestamp + (request.deadlineSeconds ?? 300),
  }
  const tx = buildDirectTransaction(quote)
  const gas = BigInt(
    await provider.send('eth_estimateGas', [
      { from: tx.from, to: tx.to, data: tx.data, value: '0x0' },
      `0x${market.blockNumber.toString(16)}`,
      simulationState(request.account, request.inputToken),
    ]),
  )
  market.rpc.check()
  quote.gasLimit = (gas * 120n + 99n) / 100n
  quote.gasCost = gas * (market.baseFee + market.priorityFee)
  return quote
}
