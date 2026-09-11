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
export function getExplorerLink(
  chainId: number,
  data: string,
  type: ExplorerDataType,
  defaultPrefix = 'https://explorer.ophis.fi',
): string {
  let prefix = BLOCK_EXPLORER_URL_OVERRIDE
  if (!prefix) {
    try {
      prefix = getExplorerBaseUrl(chainId as SupportedChainId)
    } catch {
      // getChainInfo also knows the bridge-only destinations (Monad, X Layer),
      // which have no Ophis explorer route: link to their native explorer.
      prefix = getChainInfo(chainId as TargetChainId)?.explorer || defaultPrefix
    }
  }

  switch (type) {
    case ExplorerDataType.TRANSACTION:
      return `${prefix}/tx/${data}`

    case ExplorerDataType.TOKEN:
      // The Ophis explorer has no token page; route to the address view.
      return `${prefix}/address/${data}`

    case ExplorerDataType.BLOCK:
      return `${prefix}/block/${data}`

    case ExplorerDataType.ADDRESS:
      return `${prefix}/address/${data}`
    default:
      return `${prefix}`
  }
}
