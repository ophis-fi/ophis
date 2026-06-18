/**
 * Canonical chain slug → chainId, for translating LibertAI extraction
 * output into a cowswap-compatible URL segment.
 *
 * Slugs match the system prompt rules at functions/api/intent.ts.
 */

// Must enumerate every slug the intent parser's CHAIN_VALUES Set accepts
// (functions/api/intent.ts). When the FE sees a parsed chain entity it
// can't map here, the URL builder silently drops the chain → swap routes
// to the default chain instead of the user-requested one. Keep this map
// in sync with both `CHAIN_VALUES` (intent.ts) AND `SORTED_CHAIN_IDS`
// (libs/common-const/src/chainInfo.ts). All three are the same set.
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
  ink: 57073,
  plasma: 9745,
  // HyperEVM (999) is deliberately NOT mapped here yet: the NLP parser gates chain
  // entities on CHAIN_VALUES (functions/api/intent.ts), which omits hyperevm/hyperliquid,
  // so those slugs are unreachable. Full NLP intent wiring for 999 (add the slugs to
  // CHAIN_VALUES + SYSTEM_PROMPT in functions/api/intent.ts) is a follow-up for when the
  // HL backend is live.
}

export function chainSlugToId(slug: string): number | undefined {
  return CHAIN_SLUG_TO_ID[slug]
}
