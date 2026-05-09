/**
 * Asset URL maps for the V2 token + chain set used by the swap-intent
 * landing page. All logos self-hosted under `/logos/` to drop the
 * CoinGecko CDN dependency (audit follow-up F1, 2026-05-10). Sourced
 * from CoinGecko + trustwallet/assets at fetch time; redistribution
 * permitted under each project's license.
 *
 * Filename convention: `<kind>-<canonical>.<ext>` where:
 *   - kind = 'token' | 'chain'
 *   - canonical = lowercase symbol / chain slug (matches the values
 *     emitted by the LibertAI parser)
 *   - ext = png / jpg (preserved from upstream where applicable)
 *
 * Adding a new token/chain: drop the file under
 * apps/cowswap-frontend/public/logos/ and add an entry below.
 */

const TOKEN_LOGO_EXT: Record<string, 'png' | 'jpg'> = {
  // Stablecoins
  USDC: 'png', USDT: 'png', DAI: 'png', FRAX: 'png', LUSD: 'png',
  SUSD: 'png', GUSD: 'png', TUSD: 'png', USDP: 'png', USDE: 'png', PYUSD: 'png',
  // ETH-pegs
  ETH: 'png', WETH: 'png', STETH: 'png', WSTETH: 'png', RETH: 'png',
  CBETH: 'png', SFRXETH: 'png', EZETH: 'png', RSETH: 'png',
  // BTC-pegs
  WBTC: 'png', TBTC: 'png', CBBTC: 'png', BTCB: 'png',
  // Blue-chips
  UNI: 'png', AAVE: 'png', MKR: 'png', LDO: 'png', COMP: 'png', CRV: 'png',
  SUSHI: 'png', SNX: 'png', BAL: 'png', GNO: 'png', YFI: 'png',
  '1INCH': 'png', LINK: 'png', FXS: 'png', RPL: 'png', PENDLE: 'png', ENS: 'png',
  // Native gov
  MATIC: 'png', ARB: 'jpg', OP: 'png', AVAX: 'png', BNB: 'png',
  // Memes
  PEPE: 'png', SHIB: 'png', DOGE: 'png', BONK: 'png',
}

const CHAIN_LOGO_EXT: Record<string, 'png' | 'jpg'> = {
  ethereum: 'png',
  optimism: 'png',
  base: 'png',
  arbitrum: 'jpg',
  polygon: 'png',
  avalanche: 'png',
  gnosis: 'png',
  linea: 'jpg',
  bnb: 'png',
  megaeth: 'png',
  scroll: 'png',
  blast: 'png',
  mantle: 'png',
  zksync: 'jpg',
}

export function tokenLogo(symbol: string): string | undefined {
  const ext = TOKEN_LOGO_EXT[symbol]
  if (!ext) return undefined
  return `/logos/token-${symbol.toLowerCase()}.${ext}`
}

export function chainLogo(slug: string): string | undefined {
  const ext = CHAIN_LOGO_EXT[slug]
  if (!ext) return undefined
  return `/logos/chain-${slug}.${ext}`
}

export function entityLogo(
  type: 'sellToken' | 'buyToken' | 'amount' | 'chain',
  value: string,
): string | undefined {
  if (type === 'sellToken' || type === 'buyToken') return tokenLogo(value)
  if (type === 'chain') return chainLogo(value)
  return undefined
}
