import { NETWORK_CONFIG, TXIDVersion } from '@railgun-community/shared-models'
import { Interface } from 'ethers'
import { OPHIS_PARTNER_FEE_RECIPIENT } from '../../../packages/sdk/src/partner-fee'
import { privateNetwork, type PrivateToken, type TokenSymbol } from './networks'

// Pin one network for the entire page lifetime; switching requires a fresh session.
const requestedChain = (typeof location === 'undefined' ? null : new URLSearchParams(location.search).get('chainId'))
  ?? import.meta.env.VITE_RAILGUN_CHAIN_ID ?? null
export const SELECTED_NETWORK = privateNetwork(requestedChain === null ? 1 : Number(requestedChain))
export const CHAIN_ID = SELECTED_NETWORK.chainId
export const CHAIN = BigInt(CHAIN_ID)
export const CHAIN_NAME = SELECTED_NETWORK.name
export const NETWORK = SELECTED_NETWORK.network
export const ENVIRONMENT = ['ethereum', 'mainnet'].includes(import.meta.env.VITE_RAILGUN_ENVIRONMENT) ? 'ethereum' : 'fork'
export const CONFIG = NETWORK_CONFIG[NETWORK]
export const VERSION = TXIDVersion.V2_PoseidonMerkle
export const NATIVE_SYMBOL = SELECTED_NETWORK.nativeSymbol
export const WRAPPED_SYMBOL = SELECTED_NETWORK.wrappedSymbol
export const TOKENS: Readonly<Record<string, PrivateToken>> = Object.fromEntries([
  ...SELECTED_NETWORK.stables.map((token) => [token.symbol, token]),
  [WRAPPED_SYMBOL, { address: CONFIG.baseToken.wrappedAddress, decimals: 18, symbol: WRAPPED_SYMBOL }],
])
export type { TokenSymbol } from './networks'
export function isTokenSymbol(value: unknown): value is TokenSymbol {
  return typeof value === 'string' && Object.hasOwn(TOKENS, value)
}
export function tokenFor(symbol: string): PrivateToken {
  if (!isTokenSymbol(symbol)) throw new Error('Token is not supported on the selected private network.')
  return TOKENS[symbol]
}
export const RPC_PATH = CHAIN_ID === 1 ? '/rpc' : `/rpc/${CHAIN_ID}`
export const ROUTER = SELECTED_NETWORK.router
export const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3'
export const ROUTER_RECIPIENT = '0x0000000000000000000000000000000000000002'
export const QUOTER = SELECTED_NETWORK.quoter
export const POI_NODES = ['https://ppoi.fdi.network']
// Terminal Wallet's published connect-waku.ts default; fee signatures are verified by the SDK.
export const FEE_SIGNER =
  '0zk1qyzgh9ctuxm6d06gmax39xutjgrawdsljtv80lqnjtqp3exxayuf0rv7j6fe3z53laetcl9u3cma0q9k4npgy8c8ga4h6mx83v09m8ewctsekw4a079dcl5sw4k'
export const MIN_SWAP_GAS = 3_000_000n
export const ERC20 = new Interface([
  'function approve(address spender,uint256 amount) returns (bool)',
  'function allowance(address owner,address spender) view returns (uint256)',
  'function balanceOf(address owner) view returns (uint256)',
  'function transfer(address to,uint256 amount) returns (bool)',
])
export const PROXY = new Interface([
  'function shieldFee() view returns (uint256)',
  'function unshieldFee() view returns (uint256)',
])
export const SWAP = new Interface(['function execute(bytes commands,bytes[] inputs,uint256 deadline) payable'])
export const PERMIT = new Interface([
  'function approve(address token,address spender,uint160 amount,uint48 expiration)',
])
export const QUOTE = new Interface([
  'function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160,uint32,uint256)',
  'function quoteExactInput(bytes path,uint256 amountIn) returns (uint256 amountOut,uint160[],uint32[],uint256)',
])
// Private swaps charge 0.1% of output; the SDK's public-swap base fee is independent.
export const OPHIS_FEE = { recipient: OPHIS_PARTNER_FEE_RECIPIENT, bps: 10n }
