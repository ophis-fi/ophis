// The canonical chain list for the landing (ophis.fi). Every surface on this
// site that names or counts supported chains derives from this file: the
// homepage chain strip, the FAQ answer, the SoftwareApplication JSON-LD in
// Base.astro, the /supported-chains page, and the sitemap-listed canonical
// pages. scripts/check-chain-count.mjs additionally locks public/llms.txt to
// this list and rejects hardcoded "N EVM chains" literals anywhere in src/,
// so a chain add or remove is an edit here plus llms.txt, nothing else.
//
// The swap app keeps its own runtime chain list
// (apps/frontend/libs/common-const/src/chainInfo.ts SORTED_CHAIN_IDS, plus the
// intent-parser allowlist and slug map). When a chain launches or retires,
// update those first, then this file.

export interface EvmChain {
  /** Full public name, as written in llms.txt and on /supported-chains. */
  name: string
  /** Short display name for the homepage chain strip. */
  shortName: string
  chainId: number
  /** Logo path under public/ (same-origin; CSP img-src is 'self'). */
  logo: string
  /** Ophis-operated sovereign network: Ophis's own GPv2Settlement at a
      non-canonical address, all-in fee, 100% of surplus returned. */
  sovereign: boolean
}

// Order = homepage chain-strip display order (tests/chains.spec.ts pins it).
export const EVM_CHAINS: EvmChain[] = [
  { name: 'Ethereum', shortName: 'Ethereum', chainId: 1, logo: '/logos/chain-ethereum.png', sovereign: false },
  { name: 'BNB Smart Chain', shortName: 'BNB', chainId: 56, logo: '/logos/chain-bnb.png', sovereign: false },
  { name: 'Base', shortName: 'Base', chainId: 8453, logo: '/logos/chain-base.png', sovereign: false },
  { name: 'Arbitrum One', shortName: 'Arbitrum', chainId: 42161, logo: '/logos/chain-arbitrum.jpg', sovereign: false },
  { name: 'Polygon', shortName: 'Polygon', chainId: 137, logo: '/logos/chain-polygon.png', sovereign: false },
  { name: 'Avalanche', shortName: 'Avalanche', chainId: 43114, logo: '/logos/chain-avalanche.png', sovereign: false },
  { name: 'Linea', shortName: 'Linea', chainId: 59144, logo: '/logos/chain-linea.jpg', sovereign: false },
  { name: 'Plasma', shortName: 'Plasma', chainId: 9745, logo: '/logos/chain-plasma.svg', sovereign: false },
  { name: 'Ink', shortName: 'Ink', chainId: 57073, logo: '/logos/chain-ink.svg', sovereign: false },
  { name: 'Gnosis Chain', shortName: 'Gnosis', chainId: 100, logo: '/logos/chain-gnosis.png', sovereign: false },
  { name: 'Optimism', shortName: 'Optimism', chainId: 10, logo: '/logos/chain-optimism.png', sovereign: true },
  { name: 'Unichain', shortName: 'Unichain', chainId: 130, logo: '/logos/chain-unichain.svg', sovereign: true },
  { name: 'Robinhood Chain', shortName: 'Robinhood', chainId: 4663, logo: '/logos/chain-robinhood.svg', sovereign: true },
]

export const EVM_CHAIN_COUNT = EVM_CHAINS.length

export const SOVEREIGN_CHAINS = EVM_CHAINS.filter((c) => c.sovereign)

/** Non-EVM destinations reachable from EVM source chains via NEAR Intents. */
export const NEAR_DESTINATIONS = ['Solana', 'Bitcoin'] as const
