/**
 * Legacy OVM_ETH placeholder on the OP stack.
 *
 * The Optimism "default" token list ships an ERC-20 entry at this address on
 * chain 10 (and OP Sepolia, 11155420) with symbol "ETH" / name "Ether". It is
 * the pre-Bedrock representation of ETH and is NOT a tradeable token today.
 *
 * Crucially it collides with native ETH (NATIVE_CURRENCY_ADDRESS, 0xEeee…EEeE)
 * in the symbol -> token map. Because the swap URL slug "ETH" resolves to the
 * FIRST token registered under that symbol, the dead OVM_ETH entry shadows
 * native ETH: every native-ETH sell quotes 0xDead…0000 and the order book
 * answers NoLiquidity (it is not an EthFlow-eligible native sell, and the dead
 * contract has no routes). Excluding it lets "ETH" resolve to native ETH and
 * route through EthFlow as intended.
 */
export const LEGACY_OVM_ETH_ADDRESS = '0xDeadDeAddeAddEAddeadDEaDDEAdDeaDDeAD0000'

// The dead address is only the OVM_ETH placeholder on the OP stack. The same
// vanity address can hold a real, labelled token on other chains, so the
// exclusion is scoped per-chain rather than applied globally — excluding it
// everywhere would risk hiding a legitimate token on a future-supported chain.
const EXCLUDED_TOKENS_BY_CHAIN: Record<number, ReadonlySet<string>> = {
  10: new Set([LEGACY_OVM_ETH_ADDRESS.toLowerCase()]), // Optimism mainnet
  11155420: new Set([LEGACY_OVM_ETH_ADDRESS.toLowerCase()]), // OP Sepolia
}

/**
 * True when a token must never enter the app's token maps (selector, symbol
 * lookup, address lookup, USD-price queue) on the given chain. Matching is
 * address-only and case-insensitive; the excluded entries are dead sentinels
 * that are never a legitimate tradeable token on that chain.
 */
export function isExcludedListToken(chainId: number, address: string): boolean {
  return EXCLUDED_TOKENS_BY_CHAIN[chainId]?.has(address.toLowerCase()) ?? false
}
