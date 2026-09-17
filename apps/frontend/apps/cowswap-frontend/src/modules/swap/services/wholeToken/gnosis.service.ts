import { areAddressesEqual, EVM_NATIVE_CURRENCY_ADDRESS } from '@cowprotocol/cow-sdk'
import { defaultAbiCoder, Interface } from '@ethersproject/abi'
import { getAddress } from '@ethersproject/address'
import { TransactionRequest } from '@ethersproject/providers'

import type { DirectQuote } from './router.service'

export const GNOSIS_MPS = '0xfa57AA7beED63D03Aaf85fFd1753f5f6242588fb'
export const WXDAI = '0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d'
// Verified Gnosis deployments: gnosis.blockscout.com/address/<address>#code.
export const GNOSIS_ROUTER = '0xac4c6e212a361c968f1725b4d055b47e63f80b75'
export const GNOSIS_EXECUTOR = '0xAD27827C312Cd5E71311d68e180a9872d42dE23D'
export const SUSHI_V2_ROUTER = '0x1b02da8cb0d097eb8d57a175b88c7d8b47997506'
export const GNOSIS_PAYMENTS = '0x75FC67473A91335B5b8F8821277262a13B38c9b3'
export const MPS_PROCESSOR = '0x3221A28Ed2b2e955dA64D1D299956f277562c95C'
export const sushiInterface = new Interface([
  'function getAmountsOut(uint256,address[]) view returns(uint256[])',
  'function swapExactTokensForTokens(uint256,uint256,address[],address,uint256) returns(uint256[])',
])
const tokenInterface = new Interface(['function approve(address,uint256) returns(bool)'])
const paymentsInterface = new Interface(['function execute(bytes,bytes[],uint256) payable'])
const routerInterface = new Interface([
  'function snwapMultiple((address token,uint256 amountIn,address transferTo)[],(address token,address recipient,uint256 amountOutMin)[],(address executor,uint256 value,bytes data)[]) payable returns(uint256[])',
])

export function buildGnosisTransaction(quote: DirectQuote): TransactionRequest {
  const minimum = quote.minBuyAmount ?? 0n
  const outputToken = quote.outputToken || WXDAI
  const unwrap = areAddressesEqual(outputToken, EVM_NATIVE_CURRENCY_ADDRESS)
  const blocked = [GNOSIS_ROUTER, GNOSIS_EXECUTOR, SUSHI_V2_ROUTER, GNOSIS_PAYMENTS, GNOSIS_MPS, WXDAI]
  for (const address of [quote.account, quote.recipient, ...quote.fees.map((fee) => fee.recipient)]) {
    getAddress(address)
    if (BigInt(address) <= 2n || blocked.some((target) => areAddressesEqual(address, target)))
      throw new Error('Invalid swap recipient or sender')
  }
  if (
    [
      quote.chainId !== 100,
      !areAddressesEqual(quote.inputToken, GNOSIS_MPS),
      !unwrap && !areAddressesEqual(outputToken, WXDAI),
      quote.budget <= 0n,
      quote.sellAmount !== quote.budget,
      quote.maxInput !== quote.budget,
      quote.maxTotal !== quote.budget,
      minimum <= 0n,
      minimum > quote.buyAmount,
      quote.fees.some((fee) => fee.amount < 0n),
    ].some(Boolean)
  )
    throw new Error('Invalid Gnosis sell limits')
  const feeTotal = quote.fees.reduce((sum, fee) => sum + fee.amount, 0n)
  const transfers = quote.fees.map((fee) =>
    defaultAbiCoder.encode(['address', 'address', 'uint256'], [WXDAI, fee.recipient, fee.amount]),
  )
  transfers.push(
    unwrap
      ? defaultAbiCoder.encode(['address', 'uint256'], [quote.recipient, minimum])
      : defaultAbiCoder.encode(['address', 'address', 'uint256'], [WXDAI, quote.recipient, minimum]),
  )
  // Exact input consumes the executor's entire approval. Payments and the final sweep
  // run in the same transaction, leaving no swap proceeds in public executors.
  const executors = [
    [GNOSIS_MPS, 0, tokenInterface.encodeFunctionData('approve', [SUSHI_V2_ROUTER, quote.budget])],
    [
      SUSHI_V2_ROUTER,
      0,
      sushiInterface.encodeFunctionData('swapExactTokensForTokens', [
        quote.budget,
        minimum + feeTotal,
        [GNOSIS_MPS, WXDAI],
        GNOSIS_PAYMENTS,
        quote.expiresAt,
      ]),
    ],
    [
      GNOSIS_PAYMENTS,
      0,
      paymentsInterface.encodeFunctionData('execute', [
        `0x${'05'.repeat(quote.fees.length)}${unwrap ? '0c' : '04'}`,
        transfers,
        quote.expiresAt,
      ]),
    ],
  ]
  return {
    chainId: 100,
    from: quote.account,
    to: GNOSIS_ROUTER,
    value: '0',
    data: routerInterface.encodeFunctionData('snwapMultiple', [
      [[GNOSIS_MPS, quote.budget, GNOSIS_EXECUTOR]],
      [[outputToken, quote.recipient, minimum]],
      executors,
    ]),
    gasLimit: quote.gasLimit.toString(),
    maxFeePerGas: quote.maxFeePerGas.toString(),
    maxPriorityFeePerGas: quote.maxPriorityFeePerGas.toString(),
  }
}
