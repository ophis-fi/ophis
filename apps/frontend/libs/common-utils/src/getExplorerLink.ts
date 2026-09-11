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
 * The Ophis explorer for chains it serves; otherwise the chain's native
 * explorer from getChainInfo (which also knows the bridge-only destinations).
 * Suiscan uses /account/<addr>; every other explorer here uses /address/<addr>.
 */
function resolveExplorerPrefix(chainId: number, defaultPrefix: string): { prefix: string; addressPath: string } {
  if (BLOCK_EXPLORER_URL_OVERRIDE) return { prefix: BLOCK_EXPLORER_URL_OVERRIDE, addressPath: 'address' }
  try {
    return { prefix: getExplorerBaseUrl(chainId as SupportedChainId), addressPath: 'address' }
  } catch {
    const info = getChainInfo(chainId as TargetChainId)
    return { prefix: info?.explorer || defaultPrefix, addressPath: info?.addressPath ?? 'address' }
  }
}

export function getExplorerLink(
  chainId: number,
  data: string,
  type: ExplorerDataType,
  defaultPrefix = 'https://explorer.ophis.fi',
): string {
  const { prefix, addressPath } = resolveExplorerPrefix(chainId, defaultPrefix)

  switch (type) {
    case ExplorerDataType.TRANSACTION:
      return `${prefix}/tx/${data}`

    case ExplorerDataType.TOKEN:
      // The Ophis explorer has no token page; route to the address view.
      return `${prefix}/${addressPath}/${data}`

    case ExplorerDataType.BLOCK:
      return `${prefix}/block/${data}`

    case ExplorerDataType.ADDRESS:
      return `${prefix}/${addressPath}/${data}`
    default:
      return `${prefix}`
  }
}
