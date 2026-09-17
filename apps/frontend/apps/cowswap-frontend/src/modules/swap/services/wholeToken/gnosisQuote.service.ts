import { areAddressesEqual } from '@cowprotocol/cow-sdk'
import { JsonRpcProvider } from '@ethersproject/providers'

import BigNumber from 'bignumber.js'

import { GNOSIS_MPS, SUSHI_V2_ROUTER, sushiInterface, gnosisSellPath } from './gnosis.service'
import { getInputApprovals, simulationState } from './input.service'
import { buildDirectTransaction, DirectQuote } from './router.service'

import type { DirectRequest } from './quote.service'

export async function getGnosisQuotes(
  provider: JsonRpcProvider,
  request: DirectRequest,
  signal?: AbortSignal,
): Promise<DirectQuote[]> {
  if (!areAddressesEqual(request.inputToken, GNOSIS_MPS)) throw new Error('Unsupported Gnosis input')
  const path = gnosisSellPath(request.outputToken)
  const [block, gasPrice] = await Promise.all([provider.getBlock('latest'), provider.getGasPrice()])
  signal?.throwIfAborted()
  const raw = await provider.call(
    {
      to: SUSHI_V2_ROUTER,
      data: sushiInterface.encodeFunctionData('getAmountsOut', [request.budget, path]),
    },
    block.number,
  )
  const [amounts] = sushiInterface.decodeFunctionResult('getAmountsOut', raw)
  const gross = BigInt(amounts[amounts.length - 1].toString())
  const fees = request.fees.map((fee) => ({
    recipient: fee.recipient,
    amount: BigInt(
      new BigNumber(gross.toString()).times(fee.bps).div(10000).integerValue(BigNumber.ROUND_CEIL).toFixed(0),
    ),
  }))
  const buyAmount = gross - fees.reduce((sum, fee) => sum + fee.amount, 0n)
  const minBuyAmount = (buyAmount * BigInt(10000 - request.slippageBps)) / 10000n
  if (minBuyAmount <= 0n) return []
  const expiresAt = block.timestamp + (request.deadlineSeconds ?? 300)
  const approvals = await getInputApprovals(provider, request.account, request.budget, expiresAt, GNOSIS_MPS, 100)
  const approvalEstimates = await Promise.all(
    approvals.map((tx) =>
      provider.send('eth_estimateGas', [{ ...tx, from: request.account }, 'latest', simulationState(request.account)]),
    ),
  )
  const approvalGas = approvalEstimates.reduce((sum: bigint, gas: string) => sum + BigInt(gas), 0n)
  const baseFee = BigInt(block.baseFeePerGas?.toString() || '0')
  const priority = BigInt(gasPrice.toString()) > baseFee ? BigInt(gasPrice.toString()) - baseFee : 1n
  const quote: DirectQuote = {
    ...request,
    chainId: 100,
    route: { label: 'Sushi v2', tokens: path, fees: [] },
    fees,
    buyAmount,
    minBuyAmount,
    sellAmount: request.budget,
    maxInput: request.budget,
    maxTotal: request.budget,
    totalCost: request.budget,
    netCost: request.budget,
    usdcAmount: 0n,
    usdcRefund: 0n,
    approvalGas,
    needsApproval: approvals.length > 0,
    gasLimit: 0n,
    gasCost: 0n,
    gasCostInInput: 0n,
    maxFeePerGas: baseFee * 2n + priority,
    maxPriorityFeePerGas: priority,
    quotedAt: Date.now(),
    expiresAt,
  }
  const tx = buildDirectTransaction(quote)
  const gas = BigInt(
    await provider.send('eth_estimateGas', [
      { from: tx.from, to: tx.to, data: tx.data, value: '0x0' },
      `0x${block.number.toString(16)}`,
      simulationState(request.account, GNOSIS_MPS),
    ]),
  )
  signal?.throwIfAborted()
  quote.gasLimit = (gas * 120n + 99n) / 100n
  quote.gasCost = gas * (baseFee + priority)
  const outputPerNative = await nativeOutputRate(provider, path, block.number)
  quote.gasCostInOutput = ((gas + approvalGas) * (baseFee + priority) * outputPerNative + 10n ** 18n - 1n) / 10n ** 18n
  signal?.throwIfAborted()
  return [quote]
}

async function nativeOutputRate(provider: JsonRpcProvider, path: string[], block: number): Promise<bigint> {
  if (path.length === 2) return 10n ** 18n
  const raw = await provider.call(
    { to: SUSHI_V2_ROUTER, data: sushiInterface.encodeFunctionData('getAmountsOut', [10n ** 18n, path.slice(1)]) },
    block,
  )
  const [amounts] = sushiInterface.decodeFunctionResult('getAmountsOut', raw)
  return BigInt(amounts[amounts.length - 1].toString())
}
