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
    // Production by default. Ophis runs its own rebranded explorer at
    // explorer.ophis.fi (a fork of the CoW explorer app in apps/explorer),
    // so order/address deep-links from the swap UI point there — same path
    // scheme (`/gc`, `/arb1`, `/orders/<uid>`, …) as upstream. The dev/
    // staging/barn defaults stay on cow.fi: those internal envs have no
    // Ophis-hosted counterpart and are never user-facing in prod.
    baseUrl = process.env.REACT_APP_EXPLORER_URL_PROD || 'https://explorer.ophis.fi'
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
    // Ophis fork: OP mainnet. The Ophis explorer serves OP at /opt (its SDK
    // points at the sovereign optimism-mainnet.ophis.fi orderbook), so OP
    // order/tx/address links resolve there like every other chain (#99).
    [10 as unknown as ChainId]: `${baseUrl}/opt`,
    // Ophis fork: Unichain mainnet (chain 130). Ophis explorer serves Unichain
    // at /unichain (SDK points at the sovereign unichain-mainnet.ophis.fi
    // orderbook), so order/tx/address links resolve there.
    [130 as unknown as ChainId]: `${baseUrl}/unichain`,
    // Ophis fork: MegaETH mainnet (chain 4326). Same rationale — Blockscout
    // has no /orders/ route, so order-level URLs fall back to the address
    // page (see getExplorerOrderLink below).
    [4326 as unknown as ChainId]: 'https://megaeth.blockscout.com',
    // Ophis fork: HyperEVM mainnet (chain 999). HyperEVMScan is Blockscout-
    // flavored and likewise has no /orders/ route — same fallback applies.
    [999 as unknown as ChainId]: 'https://hyperevmscan.io',
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

  // MegaETH (4326) / HyperEVM (999) still point at Blockscout-flavored
  // explorers with no /orders/ route, so the CoW-style URL would 404. We
  // degrade gracefully by linking to the order owner's address page. The
  // CoW order UID encodes the owner in bytes 32..52, extracted from the
  // 114-char hex string (2 prefix + 64 hash + 40 owner + 8 validTo).
  // OP (10) now has /orders/ on explorer.ophis.fi/opt, so it is NOT here.
  if (
    ((chainId as number) === 4326 || (chainId as number) === 999) &&
    orderId.length === 114
  ) {
    const owner = '0x' + orderId.slice(66, 106)
    return baseUrl + `/address/${owner}`
  }

  return baseUrl + `/orders/${orderId}`
}
