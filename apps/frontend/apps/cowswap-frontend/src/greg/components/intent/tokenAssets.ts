/**
 * Asset URL maps for the V2 token + chain set used by the swap-intent
 * landing page. Sourced from CoinGecko's CDN — public, cached, stable.
 *
 * If the lookup misses (unknown symbol or stale URL), the chip falls
 * back to logo-less rendering — see IntentInput.buildChip.
 *
 * V3 should swap this for cowswap's TokenLogo + ChainIcon components
 * once we wire the token-list service into this surface.
 */

const CG = (id: string, name: string, ext: 'png' | 'jpg' | 'jpeg' | 'svg' = 'png'): string =>
  `https://assets.coingecko.com/coins/images/${id}/standard/${name}.${ext}`

export const TOKEN_LOGOS: Record<string, string> = {
  // Stablecoins
  USDC: CG('6319', 'usdc'),
  USDT: CG('325', 'Tether'),
  DAI: CG('9956', 'Badge_Dai'),
  FRAX: CG('13422', 'FRAX_icon'),
  LUSD: CG('14666', 'Group_3'),
  SUSD: CG('5013', 'sUSD'),
  GUSD: CG('5992', 'gemini-dollar-gusd'),
  TUSD: CG('3449', 'tusd'),
  USDP: CG('6013', 'Pax_Dollar'),
  USDE: CG('33613', 'USDE'),
  PYUSD: CG('31212', 'PYUSD_Logo_(2)'),

  // ETH-pegs
  ETH: CG('279', 'ethereum'),
  WETH: CG('2518', 'weth'),
  STETH: CG('13442', 'steth_logo'),
  WSTETH: CG('18834', 'wstETH'),
  RETH: CG('20764', 'reth'),
  CBETH: CG('27008', 'cbeth'),
  SFRXETH: CG('28285', 'sfrxETH_icon'),
  EZETH: CG('34753', 'Ezeth_logo_circle'),
  RSETH: CG('33800', 'Icon___Dark'),

  // BTC-pegs
  WBTC: CG('7598', 'wrapped_bitcoin_wbtc'),
  TBTC: CG('11224', '0x18084fbA666a33d37592fA2633fD49a74DD93a88'),
  CBBTC: CG('40143', 'cbbtc'),
  BTCB: CG('14108', 'Binance-bitcoin'),

  // Blue-chips
  UNI: CG('12504', 'uniswap-uni'),
  AAVE: CG('12645', 'AAVE'),
  MKR: CG('1364', 'Mark_Maker'),
  LDO: CG('13573', 'Lido_DAO'),
  COMP: CG('10775', 'COMP'),
  CRV: CG('12124', 'Curve_dao'),
  SUSHI: CG('12271', 'logo'),
  SNX: CG('3406', 'SNX'),
  BAL: CG('11683', 'Balancer'),
  GNO: CG('662', 'logo_square_simple_300px'),
  YFI: CG('11849', 'yearn'),
  '1INCH': CG('13469', '1inch-token'),
  LINK: CG('877', 'chainlink-new-logo'),
  FXS: CG('13423', 'frax_share'),
  RPL: CG('2090', 'rocket_pool'),
  PENDLE: CG('15069', 'Pendle_Logo_Normal-03'),
  ENS: CG('19785', 'acatxTm8_400x400'),

  // Native gov
  MATIC: CG('4713', 'polygon'),
  ARB: CG('16547', 'arb', 'jpg'),
  OP: CG('25244', 'Optimism'),
  AVAX: CG('12559', 'Avalanche_Circle_RedWhite_Trans'),
  BNB: CG('825', 'bnb-icon2_2x'),

  // Memes
  PEPE: CG('29850', 'pepe-token'),
  SHIB: CG('11939', 'shiba'),
  DOGE: CG('5', 'dogecoin'),
  BONK: CG('28600', 'bonk'),
}

const CHAIN_LOGOS: Record<string, string> = {
  ethereum: CG('279', 'ethereum'),
  base: 'https://assets.coingecko.com/asset_platforms/images/131/standard/base-network.png',
  optimism: CG('25244', 'Optimism'),
  arbitrum: CG('16547', 'arb', 'jpg'),
  polygon: CG('4713', 'polygon'),
  avalanche: CG('12559', 'Avalanche_Circle_RedWhite_Trans'),
  gnosis: 'https://assets.coingecko.com/asset_platforms/images/21/standard/gnosis.png',
  linea: 'https://assets.coingecko.com/asset_platforms/images/135/standard/linea.jpeg',
  bnb: CG('825', 'bnb-icon2_2x'),
  megaeth: 'https://assets.coingecko.com/asset_platforms/images/197/standard/megaeth.png',
  scroll: 'https://assets.coingecko.com/asset_platforms/images/152/standard/scroll.jpeg',
  blast: 'https://assets.coingecko.com/asset_platforms/images/176/standard/blast.png',
  mantle: 'https://assets.coingecko.com/asset_platforms/images/142/standard/mantle.jpeg',
  zksync: 'https://assets.coingecko.com/asset_platforms/images/121/standard/zksync.jpeg',
}

export function tokenLogo(symbol: string): string | undefined {
  return TOKEN_LOGOS[symbol]
}

export function chainLogo(slug: string): string | undefined {
  return CHAIN_LOGOS[slug]
}

export function entityLogo(type: 'sellToken' | 'buyToken' | 'amount' | 'chain', value: string): string | undefined {
  if (type === 'sellToken' || type === 'buyToken') return tokenLogo(value)
  if (type === 'chain') return chainLogo(value)
  return undefined
}
