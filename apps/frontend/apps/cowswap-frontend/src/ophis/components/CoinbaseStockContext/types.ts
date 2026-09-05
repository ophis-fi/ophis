/**
 * Shape served by GET /api/base/tokenized-stocks (functions/api/base/tokenized-stocks.ts),
 * one entry per token in /token-lists/coinbase-tokenized-stocks.json.
 */
export interface CoinbaseStockAsset {
  address: string
  symbol: string
  name: string
  /** Corporate-action multiplier as an 18-decimal string, e.g. "1.020000000000000000". */
  multiplier: string
  /** false while the issuer has not minted any supply yet (quotes return no liquidity). */
  issued: boolean
  /** true when the B20 TRANSFER feature is paused on-chain. */
  transfersPaused: boolean
}

export interface CoinbaseStockAssetsResponse {
  chainId: number
  assets: CoinbaseStockAsset[]
}
