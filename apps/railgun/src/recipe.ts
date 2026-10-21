import {
  AbiCoder,
  Contract,
  getAddress,
  parseUnits,
  solidityPacked,
  type ContractTransaction,
  type JsonRpcProvider,
} from 'ethers'
import { UnshieldNote } from '@railgun-community/engine'
import {
  CONFIG,
  ERC20,
  OPHIS_FEE,
  PERMIT,
  PERMIT2,
  PROXY,
  QUOTE,
  QUOTER,
  ROUTER,
  ROUTER_RECIPIENT,
  SWAP,
  TOKENS,
  type TokenSymbol,
} from './config'

export interface SwapQuote {
  sell: TokenSymbol
  buy: TokenSymbol
  amount: bigint
  swapAmount: bigint
  ophisFee: bigint
  minimum: bigint
  expected: bigint
  shieldFee: bigint
  unshieldFee: bigint
  account: string
  deadline: number
  calls: ContractTransaction[]
}

export function amountFromInput(value: string, token: TokenSymbol): bigint {
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value))
    throw new Error('Enter a positive token amount without exponent notation.')
  const amount = parseUnits(value, TOKENS[token].decimals)
  if (amount <= 0n || amount >= 2n ** 120n) throw new Error('Token amount is out of range.')
  return amount
}

export function unshieldAmount(amount: bigint, feeBps: bigint): bigint {
  if (amount <= 0n || feeBps < 0n || feeBps >= 10_000n) throw new Error('Invalid amount or Railgun fee.')
  const { amount: available } = UnshieldNote.getAmountFeeFromValue(amount, feeBps)
  if (available <= 0n) throw new Error('Amount is too small after fees.')
  return available
}

export function recipeCalls(
  sell: TokenSymbol,
  buy: TokenSymbol,
  account: string,
  swapAmount: bigint,
  minimum: bigint,
  deadline: number,
): ContractTransaction[] {
  if (sell === buy || minimum <= 0n || swapAmount <= 0n) throw new Error('Invalid private swap.')
  const tokenIn = TOKENS[sell].address
  const tokenOut = TOKENS[buy].address
  const recipient = getAddress(account)
  const abi = AbiCoder.defaultAbiCoder()
  const path = solidityPacked(['address', 'uint24', 'address'], [tokenIn, 500, tokenOut])
  const inputs = [
    abi.encode(['address', 'uint256', 'uint256', 'bytes', 'bool'], [ROUTER_RECIPIENT, swapAmount, minimum, path, true]),
    abi.encode(['address', 'address', 'uint256'], [tokenOut, OPHIS_FEE.recipient, OPHIS_FEE.bps]),
    abi.encode(['address', 'address', 'uint256'], [tokenOut, recipient, minimum]),
    abi.encode(['address', 'address', 'uint256'], [tokenIn, recipient, 0]),
  ]
  return [
    { to: tokenIn, data: ERC20.encodeFunctionData('approve', [PERMIT2, swapAmount]), value: 0n },
    { to: PERMIT2, data: PERMIT.encodeFunctionData('approve', [tokenIn, ROUTER, swapAmount, deadline]), value: 0n },
    // No allow-revert bits: the swap, output fee and sweeps succeed or revert together.
    { to: ROUTER, data: SWAP.encodeFunctionData('execute', ['0x00060404', inputs, deadline]), value: 0n },
    { to: PERMIT2, data: PERMIT.encodeFunctionData('approve', [tokenIn, ROUTER, 0, deadline]), value: 0n },
    { to: tokenIn, data: ERC20.encodeFunctionData('approve', [PERMIT2, 0]), value: 0n },
  ]
}

export async function quoteSwap(
  provider: JsonRpcProvider,
  sell: TokenSymbol,
  value: string,
  account: string,
): Promise<SwapQuote> {
  if ((await provider.getNetwork()).chainId !== 1n) throw new Error('Ethereum RPC required.')
  const buy: TokenSymbol = sell === 'USDC' ? 'WETH' : 'USDC'
  const amount = amountFromInput(value, sell)
  const proxy = new Contract(CONFIG.proxyContract, PROXY, provider)
  const [shieldFee, unshieldFee]: bigint[] = await Promise.all([
    proxy.getFunction('shieldFee')(),
    proxy.getFunction('unshieldFee')(),
  ])
  const swapAmount = unshieldAmount(amount, unshieldFee)
  const result = await new Contract(QUOTER, QUOTE, provider)
    .getFunction('quoteExactInputSingle')
    .staticCall([TOKENS[sell].address, TOKENS[buy].address, swapAmount, 500, 0])
  const grossExpected = BigInt(result[0])
  const ophisFee = (grossExpected * OPHIS_FEE.bps) / 10_000n
  const expected = grossExpected - ophisFee
  const minimum = (expected * 9950n) / 10_000n
  const deadline = Math.floor(Date.now() / 1000) + 600
  const calls = recipeCalls(sell, buy, account, swapAmount, minimum, deadline)
  return {
    sell,
    buy,
    amount,
    swapAmount,
    ophisFee,
    minimum,
    expected,
    shieldFee,
    unshieldFee,
    account,
    deadline,
    calls,
  }
}

export function assertQuoteFresh(quote: SwapQuote, account: string): void {
  if (getAddress(quote.account) !== getAddress(account))
    throw new Error('Private account changed. Request another quote.')
  if (Date.now() / 1000 >= quote.deadline - 60) throw new Error('Quote expired. Request another quote.')
}
