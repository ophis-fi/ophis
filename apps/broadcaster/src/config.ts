import { NETWORK_CONFIG, NetworkName, TXIDVersion } from '@railgun-community/shared-models'
import { isAbsolute, resolve } from 'node:path'
import { getAddress, ZeroAddress } from 'ethers'

export const NETWORK = NETWORK_CONFIG[NetworkName.Ethereum]
export const VERSION = TXIDVersion.V2_PoseidonMerkle
export const BROADCASTER_VERSION = '8.0.0'
export const PUBSUB_TOPIC = '/waku/2/rs/5/1'
export const TOPICS = {
  fees: '/railgun/v2/0-1-fees/json',
  transact: '/railgun/v2/0-1-transact/json',
  response: '/railgun/v2/0-1-transact-response/json',
}
export const MAX_MESSAGE_BYTES = 512 * 1024
export const MAX_GAS = 8_000_000n
export const FEE_LIFETIME_MS = 5 * 60_000
export const TOKENS = [
  { symbol: 'WETH', address: NETWORK.baseToken.wrappedAddress, decimals: 18 },
  { symbol: 'USDC', address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6 },
  { symbol: 'USDT', address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', decimals: 6 },
] as const

export interface Settings {
  mode: 'mainnet' | 'fork'
  admission: 'pilot' | 'public'
  enabled: boolean
  rpc: string
  waku: string
  state: string
  secrets: string
  maxGasPrice: bigint
  maxTransactionCost: bigint
  dailyBudget: bigint
  reserve: bigint
  marginBps: bigint
  executionGuard: string | undefined
  pilotAccount?: string
  pilotWithdrawalRecipient?: string
  operatorAddress?: string
}

export function settings(env: NodeJS.ProcessEnv): Settings {
  const mode = env.OPHIS_BROADCASTER_MODE ?? 'mainnet'
  if (mode !== 'mainnet' && mode !== 'fork') throw new Error('Invalid broadcaster mode.')
  const admission = env.OPHIS_BROADCASTER_ADMISSION ?? 'pilot'
  if (admission !== 'pilot' && admission !== 'public') throw new Error('Invalid broadcaster admission policy.')
  const rpc = new URL(env.OPHIS_BROADCASTER_RPC ?? 'http://100.69.134.7:8547')
  const waku = new URL(env.OPHIS_BROADCASTER_WAKU ?? 'http://127.0.0.1:8645')
  if (!['http:', 'https:'].includes(rpc.protocol) || rpc.username || rpc.password ||
    !['http:', 'https:'].includes(waku.protocol) || waku.username || waku.password ||
    !['localhost', '127.0.0.1', '[::1]', 'nwaku'].includes(waku.hostname))
    throw new Error('Use an explicit trusted read RPC and a private local Waku REST endpoint.')
  if (mode === 'fork' && (rpc.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(rpc.hostname)))
    throw new Error('Fork mode requires a loopback Anvil RPC.')
  const state = resolve(env.OPHIS_BROADCASTER_STATE ?? './data')
  const secrets = env.OPHIS_BROADCASTER_SECRETS ?? resolve(mode === 'fork' ? './secrets/operator.json' : './secrets/operator.sealed.json')
  if (!isAbsolute(secrets)) throw new Error('The operator secrets path must be absolute.')
  const integer = (key: string, fallback: string): bigint => {
    const raw = env[key] ?? fallback
    if (!/^(0|[1-9][0-9]{0,29})$/.test(raw)) throw new Error(`Invalid ${key}.`)
    return BigInt(raw)
  }
  const enabled = env.OPHIS_BROADCASTER_ENABLED === '1'
  const maxGasPrice = integer('OPHIS_BROADCASTER_MAX_GAS_PRICE_WEI', '0')
  const maxTransactionCost = integer('OPHIS_BROADCASTER_MAX_TX_COST_WEI', '0')
  const reserve = integer('OPHIS_BROADCASTER_RESERVE_WEI', '0')
  const dailyBudget = integer('OPHIS_BROADCASTER_DAILY_BUDGET_WEI', '0')
  const marginBps = integer('OPHIS_BROADCASTER_MARGIN_BPS', '0')
  if (marginBps > 10_000n || (enabled && (!marginBps || !maxGasPrice || !maxTransactionCost || reserve < maxTransactionCost || dailyBudget < maxTransactionCost)))
    throw new Error('Enabling requires a positive margin and explicit gas-price, transaction-cost and gas-reserve limits.')
  const executionGuard = env.OPHIS_BROADCASTER_EXECUTION_GUARD === undefined ? undefined
    : getAddress(env.OPHIS_BROADCASTER_EXECUTION_GUARD)
  if (executionGuard === ZeroAddress) throw new Error('The execution guard must be a deployed operator-bound contract.')
  const pilotAccount = env.OPHIS_BROADCASTER_PILOT_ACCOUNT === undefined ? undefined
    : getAddress(env.OPHIS_BROADCASTER_PILOT_ACCOUNT)
  if (pilotAccount === ZeroAddress) throw new Error('The pilot account must be an explicitly selected swap account.')
  const pilotWithdrawalRecipient = env.OPHIS_BROADCASTER_PILOT_WITHDRAWAL_RECIPIENT === undefined ? undefined
    : getAddress(env.OPHIS_BROADCASTER_PILOT_WITHDRAWAL_RECIPIENT)
  if (pilotWithdrawalRecipient === ZeroAddress) throw new Error('The withdrawal pilot requires a public recipient.')
  if (admission === 'public' && (pilotAccount || pilotWithdrawalRecipient))
    throw new Error('Public admission must not specify pilot restrictions.')
  if (enabled && mode === 'mainnet' && (!executionGuard || (admission === 'pilot' && !pilotAccount)))
    throw new Error(admission === 'pilot'
      ? 'Mainnet is restricted to an explicit pilot account and an operator-bound execution guard pending live acceptance.'
      : 'Mainnet signing requires an operator-bound execution guard.')
  const operatorAddress = env.OPHIS_BROADCASTER_OPERATOR_ADDRESS === undefined ? undefined
    : getAddress(env.OPHIS_BROADCASTER_OPERATOR_ADDRESS)
  if (operatorAddress === ZeroAddress || (enabled && mode === 'mainnet' && !operatorAddress))
    throw new Error('Mainnet signing requires the verified dedicated gas-wallet address.')
  return { mode, admission, enabled, rpc: rpc.href, waku: waku.href, state, secrets, maxGasPrice,
    maxTransactionCost, dailyBudget, reserve, marginBps, executionGuard, pilotAccount, pilotWithdrawalRecipient, operatorAddress }
}
