/**
 * Asset URL maps for the V1 token + chain set used by the swap-intent
 * landing page. Sourced from CoinGecko's CDN — public, cached, stable.
 *
 * V2 should swap this out for cowswap's TokenLogo + ChainIcon
 * components once we wire the token-list service into this surface.
 */

const COINGECKO = (id: string, name: string): string =>
  `https://assets.coingecko.com/coins/images/${id}/standard/${name}.png`

export const TOKEN_LOGOS: Record<string, string> = {
  USDC: COINGECKO('6319', 'usdc'),
  USDT: COINGECKO('325', 'Tether'),
  DAI: COINGECKO('9956', 'Badge_Dai'),
  ETH: COINGECKO('279', 'ethereum'),
  WETH: COINGECKO('2518', 'weth'),
}

const COINGECKO_CHAINS: Record<string, string> = {
  ethereum: 'https://assets.coingecko.com/coins/images/279/standard/ethereum.png',
  base: 'https://assets.coingecko.com/asset_platforms/images/131/standard/base-network.png',
  optimism: 'https://assets.coingecko.com/coins/images/25244/standard/Optimism.png',
  arbitrum: 'https://assets.coingecko.com/coins/images/16547/standard/arb.jpg',
  polygon: 'https://assets.coingecko.com/coins/images/4713/standard/polygon.png',
  avalanche: 'https://assets.coingecko.com/coins/images/12559/standard/Avalanche_Circle_RedWhite_Trans.png',
  gnosis: 'https://assets.coingecko.com/asset_platforms/images/21/standard/gnosis.png',
  linea: 'https://assets.coingecko.com/asset_platforms/images/135/standard/linea.jpeg',
  bnb: 'https://assets.coingecko.com/coins/images/825/standard/bnb-icon2_2x.png',
  megaeth: 'https://assets.coingecko.com/asset_platforms/images/197/standard/megaeth.png',
}

export function tokenLogo(symbol: string): string | undefined {
  return TOKEN_LOGOS[symbol]
}

export function chainLogo(slug: string): string | undefined {
  return COINGECKO_CHAINS[slug]
}

export function entityLogo(type: 'sellToken' | 'buyToken' | 'amount' | 'chain', value: string): string | undefined {
  if (type === 'sellToken' || type === 'buyToken') return tokenLogo(value)
  if (type === 'chain') return chainLogo(value)
  return undefined
}
