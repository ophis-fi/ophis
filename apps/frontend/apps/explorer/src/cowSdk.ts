import { ApiBaseUrls, MetadataApi, OrderBookApi, SupportedChainId } from '@cowprotocol/cow-sdk'
import { SubgraphApi } from '@cowprotocol/sdk-subgraph'

// Ophis fork: hardcode the full OrderBook baseUrls map, including OP mainnet (chain 10)
// whose SOVEREIGN orderbook lives at optimism-mainnet.ophis.fi (host root, no path
// segment). Mirrors apps/cowswap-frontend/src/cowSdk.ts. Without an explicit entry the
// SDK would hit api.cow.fi/optimism for chain 10 (404), so the explorer could not serve
// OP orders. REACT_APP_ORDER_BOOK_URLS, when set, is merged on top for deploy-time override.
const PROD_BASE_URL = 'https://api.cow.fi'
const OPHIS_OP_ORDERBOOK_URL = 'https://optimism-mainnet.ophis.fi'
// Ophis HyperEVM mainnet orderbook (chain 999, re-enabled 2026-06-17), so the
// explorer can serve 999 orders. Self-hosted host root, no path segment.
const OPHIS_HYPEREVM_ORDERBOOK_URL = 'https://hyperevm.ophis.fi'

const OPHIS_ORDERBOOK_BASE_URLS = {
  [SupportedChainId.MAINNET]: `${PROD_BASE_URL}/mainnet`,
  [SupportedChainId.GNOSIS_CHAIN]: `${PROD_BASE_URL}/xdai`,
  [SupportedChainId.ARBITRUM_ONE]: `${PROD_BASE_URL}/arbitrum_one`,
  [SupportedChainId.BASE]: `${PROD_BASE_URL}/base`,
  [SupportedChainId.SEPOLIA]: `${PROD_BASE_URL}/sepolia`,
  [SupportedChainId.POLYGON]: `${PROD_BASE_URL}/polygon`,
  [SupportedChainId.AVALANCHE]: `${PROD_BASE_URL}/avalanche`,
  [SupportedChainId.BNB]: `${PROD_BASE_URL}/bnb`,
  [SupportedChainId.LINEA]: `${PROD_BASE_URL}/linea`,
  [SupportedChainId.PLASMA]: `${PROD_BASE_URL}/plasma`,
  [SupportedChainId.INK]: `${PROD_BASE_URL}/ink`,
  [10 as unknown as SupportedChainId]: OPHIS_OP_ORDERBOOK_URL,
  // Ophis HyperEVM mainnet orderbook
  [999 as unknown as SupportedChainId]: OPHIS_HYPEREVM_ORDERBOOK_URL,
} as unknown as ApiBaseUrls

const envBaseUrls = process.env.REACT_APP_ORDER_BOOK_URLS
  ? JSON.parse(process.env.REACT_APP_ORDER_BOOK_URLS)
  : undefined

const baseUrls = (envBaseUrls
  ? { ...OPHIS_ORDERBOOK_BASE_URLS, ...envBaseUrls }
  : OPHIS_ORDERBOOK_BASE_URLS) as unknown as ApiBaseUrls

const apiKey = process.env.THEGRAPH_API_KEY || ''

export const orderBookSDK = new OrderBookApi({
  env: 'prod',
  baseUrls,
})

export const subgraphApiSDK = new SubgraphApi(apiKey)

export const metadataApiSDK = new MetadataApi()
