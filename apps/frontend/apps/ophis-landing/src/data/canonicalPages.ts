// The canonical fact pages (pricing, supported chains, security) and the
// evergreen /learn guides. Shared by the pages themselves (visible "Last
// updated" date) and src/pages/sitemap.xml.ts (lastmod), so the two cannot
// drift. Bump `updated` when a page's content changes materially.

export interface CanonicalPage {
  /** Trailing-slash path, matching the 200 URL CF Pages serves. */
  path:
    | '/pricing/'
    | '/supported-chains/'
    | '/security/'
    | '/stablecoin-swaps/'
    | '/tokenized-stocks-rwa/'
    | '/ai-agent-crypto-swap-api/'
    | '/swap/robinhood-chain/'
    | '/migrate/odos-api/'
    | '/learn/'
    | '/learn/intent-based-dex-aggregator/'
    | '/learn/mev-protected-swaps/'
    | '/learn/ai-agent-token-swaps/'
    | '/learn/mcp-server-for-trading/'
    | '/learn/ai-agent-custody/'
    | '/learn/api-keys-vs-wallet-signatures/'
    | '/learn/what-is-eip-712/'
    | '/learn/what-is-a-sandwich-attack/'
    | '/learn/what-is-a-solver/'
    | '/learn/coincidence-of-wants/'
    | '/learn/slippage-vs-signed-limit/'
    | '/learn/what-is-surplus/'
    | '/learn/mev-blockers-vs-batch-auctions/'
  updated: Date
}

export const CANONICAL_PAGES: CanonicalPage[] = [
  { path: '/pricing/', updated: new Date('2026-08-02') },
  { path: '/supported-chains/', updated: new Date('2026-08-02') },
  { path: '/security/', updated: new Date('2026-08-21') },
  { path: '/stablecoin-swaps/', updated: new Date('2026-09-02') },
  { path: '/tokenized-stocks-rwa/', updated: new Date('2026-09-02') },
  { path: '/ai-agent-crypto-swap-api/', updated: new Date('2026-09-02') },
  { path: '/swap/robinhood-chain/', updated: new Date('2026-09-02') },
  { path: '/migrate/odos-api/', updated: new Date('2026-09-02') },
  { path: '/learn/', updated: new Date('2026-08-03') },
  { path: '/learn/intent-based-dex-aggregator/', updated: new Date('2026-08-02') },
  { path: '/learn/mev-protected-swaps/', updated: new Date('2026-08-02') },
  { path: '/learn/ai-agent-token-swaps/', updated: new Date('2026-08-02') },
  { path: '/learn/mcp-server-for-trading/', updated: new Date('2026-08-03') },
  { path: '/learn/ai-agent-custody/', updated: new Date('2026-08-03') },
  { path: '/learn/api-keys-vs-wallet-signatures/', updated: new Date('2026-08-03') },
  { path: '/learn/what-is-eip-712/', updated: new Date('2026-08-03') },
  { path: '/learn/what-is-a-sandwich-attack/', updated: new Date('2026-08-03') },
  { path: '/learn/what-is-a-solver/', updated: new Date('2026-08-03') },
  { path: '/learn/coincidence-of-wants/', updated: new Date('2026-08-03') },
  { path: '/learn/slippage-vs-signed-limit/', updated: new Date('2026-08-03') },
  { path: '/learn/what-is-surplus/', updated: new Date('2026-08-03') },
  { path: '/learn/mev-blockers-vs-batch-auctions/', updated: new Date('2026-08-03') },
]

export function canonicalPage(path: CanonicalPage['path']): CanonicalPage {
  const page = CANONICAL_PAGES.find((p) => p.path === path)
  if (!page) throw new Error(`canonicalPages.ts has no entry for ${path}`)
  return page
}
