import { CHAIN_INFO } from '@cowprotocol/common-const'
import { isBtcAddress, isEvmAddress, isSolanaAddress, SupportedChainId, TargetChainId } from '@cowprotocol/cow-sdk'
import { getAddress } from '@ethersproject/address'
import { AddressZero } from '@ethersproject/constants'
import { Contract, ContractInterface } from '@ethersproject/contracts'
import { JsonRpcProvider, JsonRpcSigner } from '@ethersproject/providers'

import { t } from '@lingui/core/macro'

import { getExplorerBaseUrl, getExplorerOrderLink } from './explorer'

/**
 * Environment variable to override the block explorer URL.
 * Useful for local development with tools like Otterscan.
 */
const BLOCK_EXPLORER_URL_OVERRIDE = process.env.REACT_APP_BLOCK_EXPLORER_URL

export function escapeRegExp(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') // $& means the whole matched string
}

// account is optional
export function getContract(
  address: string,
  ABI: ContractInterface,
  provider: JsonRpcProvider,
  account?: string,
): Contract {
  if (!isAddress(address) || address === AddressZero) {
    throw Error(`Invalid 'address' parameter '${address}'.`)
  }

  return new Contract(address, ABI, getProviderOrSigner(provider, account))
}

// account is optional
export function getProviderOrSigner(provider: JsonRpcProvider, account?: string): JsonRpcProvider | JsonRpcSigner {
  return account ? getSigner(provider, account) : provider
}

// account is not optional
export function getSigner(provider: JsonRpcProvider, account: string): JsonRpcSigner {
  return provider.getSigner(account).connectUnchecked()
}

// returns the checksummed address if the address is valid, otherwise returns false
export function isAddress(value: string | undefined | null): string | false {
  try {
    return getAddress(value as never)
  } catch {
    return false
  }
}

// shorten the checksummed version of the input address to have 0x + 4 characters at start and end
export function shortenAddress(address: string, chars = 4): string {
  if (isEvmAddress(address)) {
    const parsed = isAddress(address)
    if (!parsed) {
      throw Error(`Invalid 'address' parameter '${address}'.`)
    }
    return makeAddressShorter(parsed, chars)
  }

  if (isCaseSensitiveAddress(address)) {
    return makeAddressShorter(address, chars)
  }

  throw Error(`Invalid 'address' parameter '${address}'.`)
}

function isCaseSensitiveAddress(address: string): boolean {
  return isBtcAddress(address) || isSolanaAddress(address)
}

function makeAddressShorter(address: string, chars = 4): string {
  return `${address.substring(0, chars + 2)}...${address.substring(address.length - chars)}`
}

const COW_ORDER_ID_LENGTH = 114 // 112 (56 bytes in hex) + 2 (it's prefixed with "0x")

export type BlockExplorerLinkType =
  | 'transaction'
  | 'token'
  | 'address'
  | 'block'
  | 'token-transfer'
  | 'composable-order'
  | 'event'
  | 'contract'

export function formatOrderId(orderId: string): string {
  const has0x = orderId.match('0x')

  // 0x is at index 0 of orderId, shorten. Else return id as is
  return has0x?.index === 0 ? shortenOrderId(orderId) : orderId
}

// Get the right block explorer URL by chainId
export function getBlockExplorerUrl(
  chainId: SupportedChainId,
  type: BlockExplorerLinkType,
  data: string,
  base?: string,
): string {
  return getEtherscanUrl(chainId, data, type, base)
}

export function getEtherscanLink(chainId: SupportedChainId, type: BlockExplorerLinkType, data: string): string {
  if (isCowOrder(type, data)) {
    // Explorer for CoW orders:
    //    If a transaction has the size of the CoW orderId, then it's a meta-tx
    return getExplorerOrderLink(chainId, data)
  } else {
    return getEtherscanUrl(chainId, data, type)
  }
}

export function getExplorerLabel(_chainId: SupportedChainId, type: BlockExplorerLinkType, data?: string): string {
  // All links now point at the Ophis explorer (explorer.ophis.fi), for both CoW
  // orders and tx/address links, so the label no longer names a native scanner.
  return isCowOrder(type, data) ? t`View on Explorer` : t`View on Ophis Explorer`
}

// TODO: Add proper return type annotation
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function isCowOrder(type: BlockExplorerLinkType, data?: string) {
  if (!data) return false

  return type === 'transaction' && data.length === COW_ORDER_ID_LENGTH
}

export function shortenOrderId(orderId: string): string {
  return orderId.slice(0, 6) + '...' + orderId.slice(orderId.length - 4)
}

// eslint-disable-next-line complexity
function getEtherscanUrl(chainId: TargetChainId, data: string, type: BlockExplorerLinkType, base?: string): string {
  // Prefer the Ophis explorer (explorer.ophis.fi) per-chain base over the chain's
  // native scanner. getExplorerBaseUrl throws for unsupported chains, so fall back
  // to CHAIN_INFO.explorer. The env override and an explicit `base` (bridge
  // networks) still win.
  let ophisBase: string | undefined
  try {
    ophisBase = getExplorerBaseUrl(chainId as SupportedChainId)
  } catch {
    ophisBase = CHAIN_INFO[chainId]?.explorer
  }
  const basePath = BLOCK_EXPLORER_URL_OVERRIDE || base || ophisBase

  if (!basePath) return ''

  switch (type) {
    case 'transaction':
      return `${basePath}/tx/${data}`
    case 'token':
      // The Ophis explorer has no token page; route to the address view.
      return `${basePath}/address/${data}`
    case 'block':
      return `${basePath}/block/${data}`
    case 'token-transfer':
      return `${basePath}/address/${data}#tokentxns`
    case 'event':
      return `${basePath}/tx/${data}#eventlog`
    case 'contract':
      return `${basePath}/address/${data}#code`
    case 'address':
    default:
      return `${basePath}/address/${data}`
  }
}
