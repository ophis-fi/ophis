import { areAddressesEqual, EVM_NATIVE_CURRENCY_ADDRESS } from '@cowprotocol/cow-sdk'
import { defaultAbiCoder, Interface } from '@ethersproject/abi'
import { getAddress } from '@ethersproject/address'
import { AddressZero } from '@ethersproject/constants'
import { TransactionRequest } from '@ethersproject/providers'

import { buildGnosisTransaction, GNOSIS_MPS, WXDAI } from './gnosis.service'
import { isSupportedMpsOutput } from './outputTokens.service'
import { sellCommands } from './sellTransaction.service'

// Ethereum deployments: https://developers.uniswap.org/docs/protocols/v3/deployments/v3-ethereum-deployments
export const ROUTER = '0x66a9893cc07d91d95644aedd05d03f95e1dba8af'
export const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
export const MPS = '0x96c645D3D3706f793Ef52C19bBACe441900eD47D'
export const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
export const QUOTER = '0x61fFE014bA17989E743c5F6cB21bF9697530B21e'
export const MPS_V2_PAIR = '0xcD6F65A972551FFaC9B52Fa2D4a561D9b7AB4741'
const routerInterface = new Interface(['function execute(bytes commands, bytes[] inputs, uint256 deadline) payable'])
export const ROUTER_RECIPIENT = '0x0000000000000000000000000000000000000002'

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
  chainId?: 1 | 100
  inputToken?: string
  outputToken?: string
  minBuyAmount?: bigint
  gasCostInInput?: bigint
  gasCostInOutput?: bigint
  approvalGas?: bigint
  needsApproval?: boolean
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
  if (quote.chainId === 100) return buildGnosisTransaction(quote)
  if (quote.chainId !== undefined && quote.chainId !== 1) throw new Error('Unsupported direct chain')
  if (!isMpsSell(quote) && !areAddressesEqual(directOutputToken(quote), MPS))
    throw new Error('Unsupported direct output')
  validateQuote(quote)
  const feeTotal = quote.fees.reduce((sum, fee) => sum + fee.amount, 0n)
  const { commands, inputs } = isMpsSell(quote) ? sellCommands(quote, feeTotal) : buyCommands(quote, feeTotal)
  return {
    chainId: 1,
    from: quote.account,
    to: ROUTER,
    value: quote.inputToken ? '0' : (quote.maxInput + feeTotal).toString(),
    data: routerInterface.encodeFunctionData('execute', [`0x${commands.join('')}`, inputs, quote.expiresAt]),
    gasLimit: quote.gasLimit.toString(),
    maxFeePerGas: quote.maxFeePerGas.toString(),
    maxPriorityFeePerGas: quote.maxPriorityFeePerGas.toString(),
  }
}

function validateQuote(quote: DirectQuote): void {
  if (quote.inputToken && ![USDC, MPS].some((token) => areAddressesEqual(quote.inputToken, token)))
    throw new Error('Unsupported direct input')
  getAddress(quote.account)
  getAddress(quote.recipient)
  const recipients = [quote.account, quote.recipient, ...quote.fees.map((fee) => fee.recipient)]
  if (recipients.some((address) => BigInt(address) <= 2n || areAddressesEqual(address, ROUTER))) {
    throw new Error('Invalid swap recipient or sender')
  }
  if (quote.buyAmount <= 0n || quote.maxInput < quote.sellAmount || quote.maxTotal > quote.budget) {
    throw new Error('Invalid swap limits')
  }
  if (quote.fees.some((fee) => fee.amount < 0n)) throw new Error('Invalid fee')
  if (isMpsSell(quote)) validateSellLimits(quote)
}

function validateSellLimits(quote: DirectQuote): void {
  const minimum = quote.minBuyAmount ?? 0n
  if (
    [
      !isSupportedMpsOutput(1, directOutputToken(quote)),
      minimum <= 0n,
      minimum > quote.buyAmount,
      quote.sellAmount <= 0n,
      quote.sellAmount !== quote.budget,
      quote.maxInput !== quote.budget,
      quote.maxTotal !== quote.budget,
      !areAddressesEqual(quote.route.tokens[0], quote.route.viaV2 ? USDC : MPS),
      !areAddressesEqual(quote.route.tokens[quote.route.tokens.length - 1], directWrappedOutputToken(quote)),
    ].some(Boolean)
  )
    throw new Error('Invalid MPS sell limits')
}

export function isMpsSell(quote: { inputToken?: string }): boolean {
  return [MPS, GNOSIS_MPS].some((token) => areAddressesEqual(quote.inputToken, token))
}

export function fundingCommands(
  quote: DirectQuote,
  inputToken: string,
  feeTotal: bigint,
): { commands: string[]; inputs: string[] } {
  const commands = [quote.inputToken ? '02' : '0b']
  const inputs = [
    quote.inputToken
      ? defaultAbiCoder.encode(
          ['address', 'address', 'uint160'],
          [inputToken, ROUTER_RECIPIENT, quote.maxInput + feeTotal],
        )
      : defaultAbiCoder.encode(['address', 'uint256'], [ROUTER_RECIPIENT, quote.maxInput + feeTotal]),
  ]
  return { commands, inputs }
}

function buyCommands(quote: DirectQuote, feeTotal: bigint): { commands: string[]; inputs: string[] } {
  const inputToken = quote.inputToken || WETH
  const { commands, inputs } = fundingCommands(quote, inputToken, feeTotal)
  appendFees(quote, inputToken, commands, inputs)
  if (quote.route.tokens.length > 1) {
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
  }
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
  if (quote.inputToken) {
    commands.push('04')
    inputs.push(defaultAbiCoder.encode(['address', 'address', 'uint256'], [inputToken, quote.account, 0]))
  } else {
    commands.push('0c', '04')
    inputs.push(defaultAbiCoder.encode(['address', 'uint256'], [quote.account, 0]))
    inputs.push(defaultAbiCoder.encode(['address', 'address', 'uint256'], [AddressZero, quote.account, 0]))
  }
  return { commands, inputs }
}

export function appendFees(quote: DirectQuote, inputToken: string, commands: string[], inputs: string[]): void {
  for (const fee of quote.fees) {
    getAddress(fee.recipient)
    commands.push('05')
    inputs.push(defaultAbiCoder.encode(['address', 'address', 'uint256'], [inputToken, fee.recipient, fee.amount]))
  }
}

export function directChainId(quote: { chainId?: 1 | 100 }): 1 | 100 {
  return quote.chainId ?? 1
}

export function directOutputToken(quote: Pick<DirectQuote, 'chainId' | 'inputToken' | 'outputToken'>): string {
  return quote.outputToken || (quote.chainId === 100 ? WXDAI : isMpsSell(quote) ? EVM_NATIVE_CURRENCY_ADDRESS : MPS)
}

export function directVenue(quote: DirectQuote): string {
  return quote.chainId === 100 ? 'Sushi' : 'Uniswap'
}

export function directGasSymbol(quote: DirectQuote): string {
  return quote.chainId === 100 ? 'xDAI' : 'ETH'
}

export function directWrappedOutputToken(quote: Pick<DirectQuote, 'chainId' | 'inputToken' | 'outputToken'>): string {
  const output = directOutputToken(quote)
  return areAddressesEqual(output, EVM_NATIVE_CURRENCY_ADDRESS) ? (quote.chainId === 100 ? WXDAI : WETH) : output
}

export function directSellProceeds(quote: DirectQuote): bigint {
  const approvalCost = (quote.approvalGas || 0n) * ((quote.maxFeePerGas + quote.maxPriorityFeePerGas) / 2n)
  return quote.buyAmount - (quote.gasCostInOutput ?? quote.gasCost + approvalCost)
}
