import { NETWORK_CONFIG, TXIDVersion, getEVMGasTypeForTransaction, EVMGasType } from '@railgun-community/shared-models'
import { isAbsolute, resolve } from 'node:path'
import { getAddress, ZeroAddress } from 'ethers'
import { PRIVATE_NETWORKS, privateNetwork, type PrivateToken } from '../../railgun/src/networks'

function chainId(value: string | undefined): number {
  if (value !== undefined && !/^[1-9][0-9]*$/.test(value)) throw new Error('Invalid broadcaster chain ID.')
  const selected = value === undefined ? 1 : Number(value)
  if (!PRIVATE_NETWORKS.some((network) => network.chainId === selected)) throw new Error('Unsupported broadcaster chain.')
  return selected
}

// One immutable chain per process; never reinterpret journals by changing a request field.
export const CHAIN_ID = chainId(process.env.OPHIS_BROADCASTER_CHAIN_ID)
export const CHAIN = BigInt(CHAIN_ID)
const selected = privateNetwork(CHAIN_ID)
export const NETWORK_NAME = selected.network
export const NETWORK = NETWORK_CONFIG[selected.network]
export const NATIVE_SYMBOL = selected.nativeSymbol
export const COMMON_TRANSACTION_TYPE = getEVMGasTypeForTransaction(selected.network, false) === EVMGasType.Type0 ? 0 : 1
export const VERSION = TXIDVersion.V2_PoseidonMerkle
export const BROADCASTER_VERSION = '8.0.0'
export const PUBSUB_TOPIC = '/waku/2/rs/5/1'
export const TOPICS = {
  fees: `/railgun/v2/0-${CHAIN_ID}-fees/json`,
  transact: `/railgun/v2/0-${CHAIN_ID}-transact/json`,
  response: `/railgun/v2/0-${CHAIN_ID}-transact-response/json`,
}
export const MAX_MESSAGE_BYTES = 512 * 1024
export const MAX_GAS = 8_000_000n
export const FEE_LIFETIME_MS = 5 * 60_000
export const TOKENS: readonly PrivateToken[] = [
  { symbol: selected.wrappedSymbol, address: NETWORK.baseToken.wrappedAddress, decimals: 18 },
  ...selected.stables,
].map((token) => ({ ...token, address: getAddress(token.address) }))

export interface Settings {
  chainId: number
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

export function assertSigningNetwork(config: Pick<Settings, 'chainId' | 'mode'>): void {
  if (config.chainId !== CHAIN_ID) throw new Error('Signing must match the process broadcaster chain.')
  if (config.mode === 'mainnet' && CHAIN_ID !== 1)
    throw new Error('Mainnet signing on this chain awaits qualified private delivery and live acceptance.')
}

export function settings(env: NodeJS.ProcessEnv): Settings {
  if (chainId(env.OPHIS_BROADCASTER_CHAIN_ID) !== CHAIN_ID)
    throw new Error('Settings must match the process broadcaster chain.')
  const mode = env.OPHIS_BROADCASTER_MODE ?? 'mainnet'
  if (mode !== 'mainnet' && mode !== 'fork') throw new Error('Invalid broadcaster mode.')
  const admission = env.OPHIS_BROADCASTER_ADMISSION ?? 'pilot'
  if (admission !== 'pilot' && admission !== 'public') throw new Error('Invalid broadcaster admission policy.')
  if (CHAIN_ID !== 1 && !env.OPHIS_BROADCASTER_RPC) throw new Error('Configure a trusted RPC for this broadcaster chain.')
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
  if (enabled) assertSigningNetwork({ chainId: CHAIN_ID, mode })
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
  return { chainId: CHAIN_ID, mode, admission, enabled, rpc: rpc.href, waku: waku.href, state, secrets, maxGasPrice,
    maxTransactionCost, dailyBudget, reserve, marginBps, executionGuard, pilotAccount, pilotWithdrawalRecipient, operatorAddress }
}
