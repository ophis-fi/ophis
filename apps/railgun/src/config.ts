import { NETWORK_CONFIG, TXIDVersion } from '@railgun-community/shared-models'
import { getAddress, Interface, ZeroAddress } from 'ethers'
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
const tokens: Record<string, PrivateToken> = Object.fromEntries([
  ...SELECTED_NETWORK.stables.map((token) => [token.symbol, token]),
  [WRAPPED_SYMBOL, { address: CONFIG.baseToken.wrappedAddress, decimals: 18, symbol: WRAPPED_SYMBOL }],
])
export const TOKENS: Readonly<Record<string, PrivateToken>> = tokens
export const ROUTE_INTERMEDIATES = Object.keys(tokens) as TokenSymbol[]
const tokenIds = new Map(Object.entries(tokens).map(([id, token]) => [getAddress(token.address), id as TokenSymbol]))
export type { TokenSymbol } from './networks'
export function tokenIdFor(address: string): TokenSymbol | undefined {
  const normalized = getAddress(address)
  return tokenIds.get(normalized)
}
export function registerToken(token: PrivateToken): TokenSymbol {
  const address = getAddress(token.address)
  if (address === ZeroAddress || !Number.isInteger(token.decimals) || token.decimals < 0 || token.decimals > 77 ||
    typeof token.symbol !== 'string' || !token.symbol.trim() || token.symbol.length > 64 || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(token.symbol))
    throw new Error('Invalid token metadata.')
  const existing = tokenIdFor(address)
  if (existing) {
    if (tokens[existing].decimals !== token.decimals) throw new Error('Token decimals changed. Review this asset before spending.')
    return existing
  }
  const id = address.toLowerCase() as TokenSymbol
  tokens[id] = Object.freeze({ address, decimals: token.decimals, symbol: token.symbol.trim() })
  tokenIds.set(address, id)
  return id
}
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
const OPHIS_ETHEREUM_BROADCASTER =
  '0zk1qy08nqrftxezyxdegx6ca055tr65f2hf3u24j9urx04e5fnzepv6nrv7j6fe3z53luvr6qkgtjukzmkcp856gs5a6wzdd3pnesr9r6ljvym9l3a4fcepgkvek3f'
// Ethereum uses the verified Ophis fee identity; other networks retain their existing discovery signer.
export const FEE_SIGNER = CHAIN_ID === 1 ? OPHIS_ETHEREUM_BROADCASTER :
  '0zk1qyzgh9ctuxm6d06gmax39xutjgrawdsljtv80lqnjtqp3exxayuf0rv7j6fe3z53laetcl9u3cma0q9k4npgy8c8ga4h6mx83v09m8ewctsekw4a079dcl5sw4k'
export const MIN_SWAP_GAS = 3_000_000n
export const PRIVATE_SLIPPAGE_BPS = 10n
export const PILOT_WITHDRAWAL_RECIPIENT: string | undefined = undefined
// Fee signatures do not verify an operator's submission path. Add identities only after reviewing it.
export const PROTECTED_BROADCASTERS: Readonly<Partial<Record<number, readonly {
  railgunAddress: string
  expiresAt: number
  maxGasPrice: bigint
  maxTransactionCost: bigint
}[]>>> = { 1: [{ railgunAddress: OPHIS_ETHEREUM_BROADCASTER, expiresAt: Date.parse('2026-11-13T00:00:00Z'),
  maxGasPrice: 500_000_000n, maxTransactionCost: 1_500_000_000_000_000n }] }
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
