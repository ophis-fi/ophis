import { areAddressesEqual, EVM_NATIVE_CURRENCY_ADDRESS } from '@cowprotocol/cow-sdk'
import { defaultAbiCoder } from '@ethersproject/abi'

import {
  DirectQuote,
  ROUTER_RECIPIENT,
  MPS,
  USDC,
  encodePath,
  fundingCommands,
  appendFees,
  directOutputToken,
  directWrappedOutputToken,
} from './router.service'

function appendSellSwap(quote: DirectQuote, commands: string[], inputs: string[], feeTotal: bigint): void {
  if (quote.route.viaV2) {
    commands.push('08')
    inputs.push(
      defaultAbiCoder.encode(
        ['address', 'uint256', 'uint256', 'address[]', 'bool'],
        [
          ROUTER_RECIPIENT,
          quote.sellAmount,
          quote.route.tokens.length === 1 ? (quote.minBuyAmount || 0n) + feeTotal : 0,
          [MPS, USDC],
          false,
        ],
      ),
    )
  }
  if (quote.route.tokens.length === 1) return
  commands.push('00')
  inputs.push(
    defaultAbiCoder.encode(
      ['address', 'uint256', 'uint256', 'bytes', 'bool'],
      [
        ROUTER_RECIPIENT,
        quote.route.viaV2 ? 1n << 255n : quote.sellAmount,
        (quote.minBuyAmount || 0n) + feeTotal,
        encodePath(quote.route),
        false,
      ],
    ),
  )
}

export function sellCommands(quote: DirectQuote, feeTotal: bigint): { commands: string[]; inputs: string[] } {
  const { commands, inputs } = fundingCommands(quote, MPS, 0n)
  appendSellSwap(quote, commands, inputs, feeTotal)
  const output = directWrappedOutputToken(quote)
  appendFees(quote, output, commands, inputs)
  const unwrap = areAddressesEqual(directOutputToken(quote), EVM_NATIVE_CURRENCY_ADDRESS)
  commands.push(unwrap ? '0c' : '04')
  inputs.push(
    unwrap
      ? defaultAbiCoder.encode(['address', 'uint256'], [quote.recipient, quote.minBuyAmount])
      : defaultAbiCoder.encode(['address', 'address', 'uint256'], [output, quote.recipient, quote.minBuyAmount]),
  )
  // Exact-input v3 swaps can stop at the price boundary without consuming all input.
  for (const token of new Set([MPS, USDC, ...quote.route.tokens.slice(0, -1)])) {
    commands.push('04')
    inputs.push(defaultAbiCoder.encode(['address', 'address', 'uint256'], [token, quote.account, 0]))
  }
  return { commands, inputs }
}
