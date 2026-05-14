/**
 * Asset URL maps for the V3 token + chain set used by the swap-intent
 * landing page. All logos self-hosted under `/logos/` (audit follow-up
 * F1, 2026-05-10) sourced from cryptologos.cc + spothq/cryptocurrency-icons
 * + CoinGecko.
 *
 * Filename convention: `<kind>-<canonical>.<ext>` where:
 *   - kind = 'token' | 'chain'
 *   - canonical = lowercase symbol / chain slug (matches the values
 *     emitted by the LibertAI parser)
 *   - ext = svg / png / jpg (preserved from upstream)
 *
 * If a token recognised by the parser has no logo file, `tokenLogo()`
 * returns `undefined` and IntentInput renders a logo-less chip
 * (graceful degradation — chip still appears with text + colored
 * border).
 *
 * Adding a new token: drop the file under
 * apps/cowswap-frontend/public/logos/ and add an entry below.
 */

const TOKEN_LOGO_EXT: Record<string, 'png' | 'jpg' | 'svg'> = {
  // Stablecoins
  USDC: 'png', USDT: 'png', DAI: 'png', FRAX: 'png', LUSD: 'png',
  SUSD: 'png', GUSD: 'png', TUSD: 'png', USDP: 'png', USDE: 'png',
  PYUSD: 'png', GHO: 'png', FDUSD: 'svg', EURC: 'png', MIM: 'png',
  // ETH-pegs
  ETH: 'png', WETH: 'png', STETH: 'png', WSTETH: 'png', RETH: 'png',
  CBETH: 'png', SFRXETH: 'png', EZETH: 'png', RSETH: 'png',
  // BTC-pegs
  WBTC: 'png', TBTC: 'png', CBBTC: 'png', BTCB: 'png', BTC: 'svg',
  // Native L1 / L2
  BNB: 'png', MATIC: 'png', ARB: 'jpg', OP: 'png', AVAX: 'png',
  APT: 'svg', SUI: 'svg', NEAR: 'svg', ATOM: 'svg', FIL: 'svg',
  HBAR: 'svg', ICP: 'svg', ALGO: 'svg', ROSE: 'svg', TON: 'svg',
  SEI: 'svg', INJ: 'svg', RUNE: 'svg', OSMO: 'svg', MNT: 'svg',
  IMX: 'svg', TRX: 'svg', LTC: 'svg', BCH: 'svg', ETC: 'svg',
  XRP: 'svg', ADA: 'svg', SOL: 'svg', DOT: 'svg', KSM: 'svg',
  XMR: 'svg', XLM: 'svg', FLOW: 'svg', VET: 'svg', HNT: 'svg',
  AR: 'svg', FLR: 'svg', TIA: 'svg', TAO: 'svg', CRO: 'svg',
  CFX: 'svg', FTM: 'svg', CELO: 'svg', KAVA: 'svg', STX: 'svg',
  WAVES: 'svg', ZEC: 'svg', DASH: 'svg',
  // DeFi blue-chips
  UNI: 'png', AAVE: 'png', MKR: 'png', LDO: 'png', COMP: 'png',
  CRV: 'png', SUSHI: 'png', SNX: 'png', BAL: 'png', GNO: 'png',
  YFI: 'png', '1INCH': 'png', LINK: 'png', FXS: 'png', RPL: 'png',
  PENDLE: 'png', ENS: 'png', EIGEN: 'svg', GRT: 'svg', JUP: 'svg',
  JTO: 'png', PYTH: 'svg', GMX: 'png', AERO: 'png', VELO: 'png',
  KAS: 'svg', DYM: 'png', CAKE: 'svg', OCEAN: 'svg', NMR: 'svg',
  RLC: 'svg', BAND: 'svg', ZRX: 'svg', PRIME: 'svg', RON: 'svg',
  NEXO: 'svg', STRK: 'png',
  // AI / RWA
  RNDR: 'png', AKT: 'svg', ONDO: 'svg', WLD: 'svg',
  // Memes
  PEPE: 'png', SHIB: 'png', DOGE: 'png', BONK: 'png', WIF: 'svg',
  FLOKI: 'svg',
  // Gaming
  SAND: 'svg', MANA: 'svg', AXS: 'svg', GALA: 'svg', APE: 'svg',
  ENJ: 'svg', CHZ: 'svg',

  // ─────────────────────────────────────────────────────────────────
  // P3 phase 2 additions (2026-05-11) — logos sourced from CoinGecko
  // top-1500 by market cap, self-hosted under /logos/. 62 new entries
  // matching the TOKEN_VALUES expansion in functions/api/intent.ts.
  // ─────────────────────────────────────────────────────────────────
  // Stablecoins
  USDS: 'png', BUSD: 'jpg',
  // L1 EVM-bridged
  QNT: 'jpg', ICX: 'png', ZIL: 'png', ASTR: 'png', LSK: 'png',
  // DeFi
  ENA: 'png', MORPHO: 'png', JOE: 'png', ORDI: 'png', USUAL: 'jpg',
  DYDX: 'png', BICO: 'jpg', KNC: 'jpg', MAGIC: 'png', MASK: 'jpg',
  OGN: 'jpg', BAT: 'png', LRC: 'png', GMT: 'png', WOO: 'png',
  GLM: 'png', CFG: 'jpg', ALCX: 'png', LPT: 'png', HOT: 'png',
  CVX: 'png', AMP: 'png', RSR: 'png', STORJ: 'png', BNT: 'png',
  ANT: 'png', ANKR: 'png', KEEP: 'jpg', MTL: 'png', AUDIO: 'png',
  CHR: 'png', SUPER: 'png', MAV: 'png', CKB: 'png', ADX: 'png',
  REQ: 'png', ELF: 'png',
  // AI / DePIN
  VIRTUAL: 'png', AIXBT: 'png', GRASS: 'jpg', NOS: 'jpg',
  MOBILE: 'png', IOTX: 'png', TFUEL: 'png',
  // Memes
  TOSHI: 'png', NEIRO: 'jpg', GOAT: 'jpg', PNUT: 'png',
  MOODENG: 'jpg', DEGEN: 'png', TRUMP: 'png', ZRO: 'jpg',
  BABYDOGE: 'jpg',
  // Gaming
  BEAM: 'png', ALICE: 'jpg',

  // ─────────────────────────────────────────────────────────────────
  // P3 phase 3 additions (2026-05-11) — manual sourcing for the
  // 42 symbols that didn't appear in the CG top-1500 phase-2 sweep.
  // Same self-host pattern. Closes the loop: 235/236 logo coverage;
  // only IPOR remains text-only (not in CG's coin list).
  // ─────────────────────────────────────────────────────────────────
  // Stablecoins
  AGEUR: 'png', SUSDS: 'png', SDAI: 'png', USDR: 'png', CRVUSD: 'jpg',
  // ETH LSTs/LRTs
  METH: 'png', EETH: 'png', WEETH: 'png', PUFETH: 'png', OSETH: 'png',
  SWETH: 'jpg', ETHX: 'png', WBETH: 'png', ANKRETH: 'png', OETH: 'png',
  // DeFi
  RDNT: 'png', SWELL: 'png', RBN: 'png', SDT: 'jpg', QUICK: 'png',
  POLY: 'png', OMG: 'jpg', ATA: 'png', STG: 'png', RAD: 'png',
  METIS: 'png',
  // AI / DePIN / RWA — including pre-existing-but-logo-less symbols
  ARKM: 'png', FET: 'png', ETHFI: 'jpg', IO: 'png', AI16Z: 'jpg',
  // Memes — including pre-existing-but-logo-less symbols
  BRETT: 'png', MOG: 'png', MEW: 'png', POPCAT: 'jpg', TURBO: 'png',
  GIGA: 'png', MICHI: 'png',
  // Gaming
  JASMY: 'jpg', PIXEL: 'png', PORTAL: 'jpg', VOXEL: 'png',
}

const CHAIN_LOGO_EXT: Record<string, 'png' | 'jpg' | 'svg'> = {
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
