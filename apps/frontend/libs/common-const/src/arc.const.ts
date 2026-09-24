import { areAddressesEqual, registerEvmChainIds, SupportedChainId } from '@cowprotocol/cow-sdk'
import { utils } from 'ethers'

import { TokenWithLogo } from './types'

export const ARC_CHAIN_ID = 5042 as SupportedChainId
export const ARC_USDC_ADDRESS = '0x3600000000000000000000000000000000000000'
export const ARC_USDC = new TokenWithLogo(undefined, ARC_CHAIN_ID, ARC_USDC_ADDRESS, 6, 'USDC', 'USDC')
export const ARC_EURC = new TokenWithLogo(
  undefined,
  ARC_CHAIN_ID,
  '0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1',
  6,
  'EURC',
  'EURC',
)
export const ARC_LOCAL = process.env.NODE_ENV !== 'production' && process.env.REACT_APP_ARC_LOCAL === 'true'
export const ARC_RPC_URL = ARC_LOCAL ? 'http://127.0.0.1:8547' : 'https://rpc.mainnet.arc.io'
export const ARC_LABEL = ARC_LOCAL ? 'Arc (local)' : 'Arc'
export const ARC_ORDERBOOK_URL = ARC_LOCAL ? 'http://127.0.0.1:8087' : process.env.REACT_APP_ARC_ORDERBOOK_URL || ''

function configuredAddress(value: string | undefined): `0x${string}` | undefined {
  return value && utils.isAddress(value) && !/^0x0{40}$/i.test(value) ? (utils.getAddress(value) as `0x${string}`) : undefined
}

export const ARC_SETTLEMENT = configuredAddress(process.env.REACT_APP_ARC_SETTLEMENT)
export const ARC_VAULT_RELAYER = configuredAddress(process.env.REACT_APP_ARC_VAULT_RELAYER)
const requested = ARC_LOCAL || process.env.REACT_APP_ARC_ENABLED === 'true'
// Deployment tooling emits these public values only after address/wiring verification.
// A production build must never silently activate local contracts or private RPC credentials.
if (requested && (!ARC_SETTLEMENT || !ARC_VAULT_RELAYER))
  throw new Error('Arc requires settlement and vault relayer addresses')
if (requested && areAddressesEqual(ARC_SETTLEMENT, ARC_VAULT_RELAYER)) throw new Error('Arc contracts must be distinct')
if (requested && !ARC_LOCAL) {
  const url = new URL(ARC_ORDERBOOK_URL)
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !url.hostname.includes('.') ||
    /^(localhost|\d+\.|\[)/.test(url.hostname) ||
    url.pathname !== '/'
  ) {
    throw new Error('Arc requires a public HTTPS orderbook URL without credentials')
  }
  if (process.env.REACT_APP_ARC_LOCAL === 'true') throw new Error('Local Arc configuration cannot enable production')
}
export const ARC_ENABLED = requested && Boolean(ARC_SETTLEMENT && ARC_VAULT_RELAYER)
export const ARC_ENABLED_CHAIN_IDS: SupportedChainId[] = ARC_ENABLED ? [ARC_CHAIN_ID] : []

if (ARC_ENABLED) registerEvmChainIds([ARC_CHAIN_ID])
