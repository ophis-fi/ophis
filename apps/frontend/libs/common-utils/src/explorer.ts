import { SupportedChainId as ChainId, UID } from '@cowprotocol/cow-sdk'

import { isBarn, isDev, isLocal, isPr, isStaging } from './environments'

function _getExplorerUrlByEnvironment(): Record<ChainId, string> {
  let baseUrl: string | undefined
  if (isLocal || isDev || isPr) {
    baseUrl = process.env.REACT_APP_EXPLORER_URL_DEV || 'https://dev.explorer.cow.fi'
  } else if (isStaging) {
    baseUrl = process.env.REACT_APP_EXPLORER_URL_STAGING || 'https://staging.explorer.cow.fi'
  } else if (isBarn) {
    baseUrl = process.env.REACT_APP_EXPLORER_URL_BARN || 'https://barn.explorer.cow.fi'
  } else {
    // Production by default
    baseUrl = process.env.REACT_APP_EXPLORER_URL_PROD || 'https://explorer.cow.fi'
  }

  return {
    [ChainId.MAINNET]: baseUrl,
    [ChainId.GNOSIS_CHAIN]: `${baseUrl}/gc`,
    [ChainId.ARBITRUM_ONE]: `${baseUrl}/arb1`,
    [ChainId.BASE]: `${baseUrl}/base`,
    [ChainId.SEPOLIA]: `${baseUrl}/sepolia`,
    [ChainId.POLYGON]: `${baseUrl}/pol`,
    [ChainId.AVALANCHE]: `${baseUrl}/avax`,
    [ChainId.BNB]: `${baseUrl}/bnb`,
    [ChainId.LINEA]: `${baseUrl}/linea`,
    [ChainId.PLASMA]: `${baseUrl}/plasma`,
    [ChainId.INK]: `${baseUrl}/ink`,
    // Ophis fork: OP mainnet. CoW doesn't operate an explorer on OP, so
    // we point at the Optimism block-explorer for tx-level links. Order-
    // level URLs won't exist there but at least the function returns a
    // string instead of throwing and crashing the React tree.
    [10 as unknown as ChainId]: 'https://optimistic.etherscan.io',
    // Ophis fork: MegaETH mainnet (chain 4326). Same rationale — Blockscout
    // has no /orders/ route, so order-level URLs fall back to the address
    // page (see getExplorerOrderLink below).
    [4326 as unknown as ChainId]: 'https://megaeth.blockscout.com',
  }
}

const EXPLORER_BASE_URL: Record<ChainId, string> = _getExplorerUrlByEnvironment()

export function getExplorerAddressLink(chainId: ChainId, address: string): string {
  const baseUrl = getExplorerBaseUrl(chainId)

  return baseUrl + `/address/${address}`
}

export function getExplorerBaseUrl(chainId: ChainId): string {
  const baseUrl = EXPLORER_BASE_URL[chainId]

  if (!baseUrl) {
    throw new Error('Unsupported Network. The operator API is not deployed in the Network ' + chainId)
  } else {
    return baseUrl
  }
}

export function getExplorerOrderLink(chainId: ChainId, orderId: UID): string {
  const baseUrl = getExplorerBaseUrl(chainId)

  // Ophis fork on OP mainnet: we point at optimistic.etherscan.io but
  // it has no /orders/ route, so the CoW-style URL would 404. Until
  // explorer.ophis.fi is stood up (task #99) we degrade gracefully by
  // linking to the order owner's Etherscan address page — they can
  // see their swap arrive in their wallet. The CoW order UID encodes
  // the owner address in bytes 32..52, so we extract it from the
  // 110-char hex string (2 prefix + 64 hash + 40 owner + 8 validTo).
  if (((chainId as number) === 10 || (chainId as number) === 4326) && orderId.length === 114) {
    const owner = '0x' + orderId.slice(66, 106)
    return baseUrl + `/address/${owner}`
  }

  return baseUrl + `/orders/${orderId}`
}
