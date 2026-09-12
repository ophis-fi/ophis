import { getChainInfo } from '@cowprotocol/common-const'
import { SupportedChainId, TargetChainId } from '@cowprotocol/cow-sdk'

import { getExplorerBaseUrl } from './explorer'

export enum ExplorerDataType {
  TRANSACTION = 'transaction',
  TOKEN = 'token',
  ADDRESS = 'address',
  BLOCK = 'block',
}

/**
 * Environment variable to override the block explorer URL.
 * Useful for local development with tools like Otterscan.
 *
 * When set, this URL will be used instead of the chain's default block explorer.
 * The URL should not include a trailing slash.
 *
 * @example
 * REACT_APP_BLOCK_EXPLORER_URL=http://localhost:8003
 */
const BLOCK_EXPLORER_URL_OVERRIDE = process.env.REACT_APP_BLOCK_EXPLORER_URL

/**
 * Return the explorer link for the given data and data type.
 *
 * Links point at the Ophis explorer (explorer.ophis.fi) via the per-chain base
 * in `./explorer` (getExplorerBaseUrl), instead of Etherscan/native scanners.
 * Unsupported chains retain the native fallback resolved by
 * getExplorerBaseUrl. Token links use the explorer's address route because
 * the Ophis explorer has no separate token page.
 */
/**
 * The Ophis explorer for chains it serves (no token page there, so token links
 * use the address route); otherwise the chain's native explorer from
 * getChainInfo (which also knows the bridge-only destinations) with its own
 * address and token routes (Suiscan /account and /coin, Tronscan /token20).
 */
type ExplorerPaths = { addressPath: string; tokenPath: string; txPath: string }

// The Ophis explorer has no token page, so token links use its address route.
const OPHIS_EXPLORER_PATHS: ExplorerPaths = { addressPath: 'address', tokenPath: 'address', txPath: 'tx' }

function nativeExplorerPaths(info: ReturnType<typeof getChainInfo> | undefined): ExplorerPaths {
  const addressPath = info?.addressPath ?? 'address'
  return { addressPath, tokenPath: info?.tokenPath ?? addressPath, txPath: info?.txPath ?? 'tx' }
}

function resolveExplorerPrefix(chainId: number, defaultPrefix: string): ExplorerPaths & { prefix: string } {
  if (BLOCK_EXPLORER_URL_OVERRIDE) return { prefix: BLOCK_EXPLORER_URL_OVERRIDE, ...OPHIS_EXPLORER_PATHS }
  try {
    return { prefix: getExplorerBaseUrl(chainId as SupportedChainId), ...OPHIS_EXPLORER_PATHS }
  } catch {
    const info = getChainInfo(chainId as TargetChainId)
    return { prefix: info?.explorer || defaultPrefix, ...nativeExplorerPaths(info) }
  }
}

export function getExplorerLink(
  chainId: number,
  data: string,
  type: ExplorerDataType,
  defaultPrefix = 'https://explorer.ophis.fi',
): string {
  const { prefix, addressPath, tokenPath, txPath } = resolveExplorerPrefix(chainId, defaultPrefix)

  switch (type) {
    case ExplorerDataType.TRANSACTION:
      return `${prefix}/${txPath}/${data}`

    case ExplorerDataType.TOKEN:
      return `${prefix}/${tokenPath}/${data}`

    case ExplorerDataType.BLOCK:
      return `${prefix}/block/${data}`

    case ExplorerDataType.ADDRESS:
      return `${prefix}/${addressPath}/${data}`
    default:
      return `${prefix}`
  }
}
