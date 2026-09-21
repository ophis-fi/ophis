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
  // September 2026 verification: stale decimals / sunset USDL, and bsdETH
  // incorrectly assigned to Ethereum (the contract exists on Base only).
  1: new Set([
    '0x7751e2f4b8ae93ef6b79d86419d42fe3295a4559',
    '0xbdc7c08592ee4aa51d06c27ee23d5087d65adbcd',
    '0xcb327b99ff831bf8223cced12b1338ff3aa322ff',
  ]),
  10: new Set([
    LEGACY_OVM_ETH_ADDRESS.toLowerCase(),
    '0xe7bc9b3a936f122f08aac3b1fac3c3ec29a78874', // ECO now reports name/symbol 0xdead.
  ]),
  11155420: new Set([LEGACY_OVM_ETH_ADDRESS.toLowerCase()]), // OP Sepolia
}

/**
 * True when a token must never enter the app's token maps (selector, symbol
 * lookup, address lookup, USD-price queue) on the given chain. Matching is
 * address-only and case-insensitive; exclusions cover dead sentinels and
 * known stale or wrongly assigned entries, including supplemental lists/caches.
 */
export function isExcludedListToken(chainId: number, address: string): boolean {
  return EXCLUDED_TOKENS_BY_CHAIN[chainId]?.has(address.toLowerCase()) ?? false
}
