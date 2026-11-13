import { areAddressesEqual, SupportedChainId, ZERO_ADDRESS } from '@cowprotocol/cow-sdk'
import { Interface } from '@ethersproject/abi'

import { NATIVE_CURRENCY_ADDRESS, WRAPPED_NATIVE_CURRENCIES } from '../nativeAndWrappedTokens'

export const RELAY_DAPP_ID = 'cow-sdk://bridging/providers/relay'
export const RELAY_ENABLED = process.env.REACT_APP_ENABLE_RELAY_BRIDGE === 'true'
export const RELAY_API_URL = '/api/relay'
export const RELAY_DEPOSIT_WINDOW = 300
export const RELAY_SOLVER = '0xf70da97812cb96acdf810712aa562db8dfa3dbef'
export const relayCurrency = (address: string): string =>
  areAddressesEqual(address, NATIVE_CURRENCY_ADDRESS) ? ZERO_ADDRESS : address

export const relayRefundCurrencies = (chainId: number, currency: string): string[] =>
  areAddressesEqual(currency, WRAPPED_NATIVE_CURRENCIES[chainId as SupportedChainId]?.address)
    ? [currency, ZERO_ADDRESS]
    : [relayCurrency(currency)]

// https://docs.relay.link/references/api/api_resources/contract-addresses (2026-11-13).
export const RELAY_CHAINS: Readonly<Record<number, string>> = {
  1: 'ethereum',
  10: 'optimism',
  56: 'bnb',
  100: 'gnosis',
  130: 'unichain',
  137: 'polygon',
  4663: 'robinhood',
  5042: 'arc',
  8453: 'base',
  9745: 'plasma',
  42161: 'arbitrum',
  43114: 'avalanche',
  57073: 'ink',
  59144: 'linea',
}
export const relayDepository = (chainId: number): string =>
  chainId === 59144 ? '0x59916da825d2d2ec1bf878d71c88826f6633ecca' : '0x4cd00e387622c35bddb9b4c962c136462338bc31'

export const relayRouterData = (chainId: number): string =>
  `0x000000000000000000000000${chainId === 59144 ? '6328ea02d28131e58b28e55c6258258a30d90e05' : '0729e2a4716d9f7dd17858d5d504426d228697f7'}`

export const RELAY_DEPOSIT = new Interface([
  'function depositErc20(address depositor,address token,uint256 amount,bytes32 id)',
  'event RelayErc20Deposit(address from,address token,uint256 amount,bytes32 id)',
])
export const RELAY_ERC20_ABI = [
  'function approve(address spender,uint256 amount) returns (bool)',
  'function balanceOf(address account) view returns (uint256)',
  'function transfer(address to,uint256 amount) returns (bool)',
]
