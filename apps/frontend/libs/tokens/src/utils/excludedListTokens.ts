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
 * contract has no routes). Excluding it at list ingestion lets "ETH" resolve to
 * native ETH and route through EthFlow as intended.
 */
export const LEGACY_OVM_ETH_ADDRESS = '0xDeadDeAddeAddEAddeadDEaDDEAdDeaDDeAD0000'

const EXCLUDED_TOKEN_ADDRESSES = new Set<string>([LEGACY_OVM_ETH_ADDRESS.toLowerCase()])

/**
 * True when a token from a fetched token list must never enter the app's token
 * maps (selector, symbol lookup, address lookup). Matching is address-only and
 * case-insensitive; the excluded addresses are dead sentinels that are never a
 * legitimate tradeable token on any chain.
 */
export function isExcludedListToken(address: string): boolean {
  return EXCLUDED_TOKEN_ADDRESSES.has(address.toLowerCase())
}
