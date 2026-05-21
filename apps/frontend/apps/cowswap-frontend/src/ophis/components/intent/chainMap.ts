/**
 * Canonical chain slug → chainId, for translating LibertAI extraction
 * output into a cowswap-compatible URL segment.
 *
 * Slugs match the system prompt rules at functions/api/intent.ts.
 */

export const CHAIN_SLUG_TO_ID: Record<string, number> = {
  ethereum: 1,
  optimism: 10,
  base: 8453,
  arbitrum: 42161,
  polygon: 137,
  avalanche: 43114,
  gnosis: 100,
  linea: 59144,
  bnb: 56,
}

export function chainSlugToId(slug: string): number | undefined {
  return CHAIN_SLUG_TO_ID[slug]
}
