import { NETWORK_CONFIG, NetworkName, TXIDVersion } from '@railgun-community/shared-models'
import { Interface } from 'ethers'
import { OPHIS_PARTNER_FEE_RECIPIENT, OPHIS_VOLUME_FEE_BPS } from '../../../packages/sdk/src/partner-fee'

export const NETWORK = NetworkName.Ethereum
export const ENVIRONMENT = import.meta.env.VITE_RAILGUN_ENVIRONMENT === 'ethereum' ? 'ethereum' : 'fork'
export const CONFIG = NETWORK_CONFIG[NETWORK]
export const VERSION = TXIDVersion.V2_PoseidonMerkle
export const TOKENS = {
  USDC: { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6 },
  WETH: { address: CONFIG.baseToken.wrappedAddress, decimals: 18 },
} as const
export type TokenSymbol = keyof typeof TOKENS
export const ROUTER = '0x66a9893cc07d91d95644aedd05d03f95e1dba8af'
export const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3'
export const ROUTER_RECIPIENT = '0x0000000000000000000000000000000000000002'
export const QUOTER = '0x61fFE014bA17989E743c5F6cB21bF9697530B21e'
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
])
export const OPHIS_FEE = { recipient: OPHIS_PARTNER_FEE_RECIPIENT, bps: BigInt(OPHIS_VOLUME_FEE_BPS) }
