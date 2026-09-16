import { defaultAbiCoder, Interface } from '@ethersproject/abi'
import { getAddress } from '@ethersproject/address'
import { TransactionRequest } from '@ethersproject/providers'

// Ethereum deployments: https://developers.uniswap.org/docs/protocols/v3/deployments/v3-ethereum-deployments
export const ROUTER = '0x66a9893cc07d91d95644aedd05d03f95e1dba8af'
export const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
export const MPS = '0x96c645D3D3706f793Ef52C19bBACe441900eD47D'
export const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
export const QUOTER = '0x61fFE014bA17989E743c5F6cB21bF9697530B21e'
export const MPS_V2_PAIR = '0xcD6F65A972551FFaC9B52Fa2D4a561D9b7AB4741'
const routerInterface = new Interface(['function execute(bytes commands, bytes[] inputs, uint256 deadline) payable'])
const ROUTER_RECIPIENT = '0x0000000000000000000000000000000000000002'

export interface Route {
  label: string
  tokens: string[]
  fees: number[]
  viaV2?: boolean
}
export interface VolumeFee {
  recipient: string
  bps: number
}
export interface DirectQuote {
  route: Route
  account: string
  recipient: string
  budget: bigint
  buyAmount: bigint
  sellAmount: bigint
  maxInput: bigint
  usdcAmount: bigint
  usdcRefund: bigint
  netCost: bigint
  fees: { recipient: string; amount: bigint }[]
  gasLimit: bigint
  gasCost: bigint
  maxFeePerGas: bigint
  maxPriorityFeePerGas: bigint
  totalCost: bigint
  maxTotal: bigint
  slippageBps: number
  quotedAt: number
  expiresAt: number
}

export function encodePath(route: Route, reverse = false): string {
  const tokens = reverse ? [...route.tokens].reverse() : route.tokens
  const fees = reverse ? [...route.fees].reverse() : route.fees
  return `0x${tokens.map((token, i) => `${i ? fees[i - 1].toString(16).padStart(6, '0') : ''}${token.slice(2)}`).join('')}`
}

export function buildDirectTransaction(quote: DirectQuote): TransactionRequest {
  getAddress(quote.account)
  getAddress(quote.recipient)
  if (quote.buyAmount <= 0n || quote.maxInput < quote.sellAmount || quote.maxTotal > quote.budget) {
    throw new Error('Invalid swap limits')
  }
  const feeTotal = quote.fees.reduce((sum, fee) => sum + fee.amount, 0n)
  const commands = ['0b']
  const inputs = [defaultAbiCoder.encode(['address', 'uint256'], [ROUTER_RECIPIENT, quote.maxInput + feeTotal])]
  for (const fee of quote.fees) {
    getAddress(fee.recipient)
    commands.push('05')
    inputs.push(defaultAbiCoder.encode(['address', 'address', 'uint256'], [WETH, fee.recipient, fee.amount]))
  }
  commands.push('01')
  inputs.push(
    defaultAbiCoder.encode(
      ['address', 'uint256', 'uint256', 'bytes', 'bool'],
      [
        quote.route.viaV2 ? ROUTER_RECIPIENT : quote.recipient,
        quote.route.viaV2 ? quote.usdcAmount : quote.buyAmount,
        quote.maxInput,
        encodePath(quote.route, true),
        false,
      ],
    ),
  )
  if (quote.route.viaV2) {
    commands.push('09', '04')
    inputs.push(
      defaultAbiCoder.encode(
        ['address', 'uint256', 'uint256', 'address[]', 'bool'],
        [quote.recipient, quote.buyAmount, quote.usdcAmount, [USDC, MPS], false],
      ),
    )
    inputs.push(defaultAbiCoder.encode(['address', 'address', 'uint256'], [USDC, quote.account, 0]))
  }
  // Return all unused wrapped/native input to the sender, including when recipient differs.
  commands.push('0c', '04')
  inputs.push(defaultAbiCoder.encode(['address', 'uint256'], [quote.account, 0]))
  inputs.push(
    defaultAbiCoder.encode(
      ['address', 'address', 'uint256'],
      ['0x0000000000000000000000000000000000000000', quote.account, 0],
    ),
  )
  return {
    chainId: 1,
    from: quote.account,
    to: ROUTER,
    value: (quote.maxInput + feeTotal).toString(),
    data: routerInterface.encodeFunctionData('execute', [`0x${commands.join('')}`, inputs, quote.expiresAt]),
    gasLimit: quote.gasLimit.toString(),
    maxFeePerGas: quote.maxFeePerGas.toString(),
    maxPriorityFeePerGas: quote.maxPriorityFeePerGas.toString(),
  }
}
