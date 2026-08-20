import { DAI, USDC_MAINNET, WETH_MAINNET } from '@cowprotocol/common-const'
import { getAddressKey } from '@cowprotocol/cow-sdk'

/**
 * Ophis-curated display metadata for the escrow-reviewed token set. This is
 * the ONLY source of token names/symbols/decimals on the OTC surface —
 * on-chain or indexed metadata is never rendered. The set mirrors the
 * OTC_ESCROW token-policy allowlist; otcTokenMeta.test.ts binds the two so
 * they cannot drift. Escrow-risk labels follow the plan's rule that
 * blacklistable or upgradeable assets are flagged as an escrow lock risk
 * (USDC ships under a documented product exception).
 */
export interface OtcTokenMeta {
  address: string
  symbol: string
  name: string
  decimals: number
  escrowRisks: readonly string[]
}

const CURATED_TOKENS: readonly OtcTokenMeta[] = [
  {
    address: WETH_MAINNET.address,
    symbol: 'WETH',
    name: 'Wrapped Ether',
    decimals: 18,
    escrowRisks: [],
  },
  {
    address: USDC_MAINNET.address,
    symbol: 'USDC',
    name: 'USD Coin',
    decimals: 6,
    escrowRisks: ['upgradeable', 'blacklistable'],
  },
  {
    address: DAI.address,
    symbol: 'DAI',
    name: 'Dai Stablecoin',
    decimals: 18,
    escrowRisks: [],
  },
]

export const OTC_CURATED_TOKENS: readonly OtcTokenMeta[] = CURATED_TOKENS

export const OTC_CURATED_TOKEN_COUNT = CURATED_TOKENS.length

const CURATED_BY_KEY = new Map(CURATED_TOKENS.map((token) => [getAddressKey(token.address), token]))

export function getOtcTokenMeta(address: string): OtcTokenMeta | null {
  return CURATED_BY_KEY.get(getAddressKey(address)) ?? null
}

/** True when both order legs are Ophis-curated (reviewed for escrow display). */
export function isOtcOrderDisplayReviewed(order: { tokenA: string; tokenB: string }): boolean {
  return getOtcTokenMeta(order.tokenA) !== null && getOtcTokenMeta(order.tokenB) !== null
}
