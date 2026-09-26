import { SupportedChainId } from '@cowprotocol/cow-sdk'

// Display attribution from these already-configured lists, not a settlement or eligibility check.
// Never apply these name conventions to wallet metadata or user-added lists.
// ponytail: suffix changes lose the badge; replace this metadata fallback with issuer lists when available.
export const LISTED_STOCK_PROVIDERS = [
  {
    id: 'bStocks',
    chainId: SupportedChainId.BNB,
    source: 'https://files.cow.fi/token-lists/CoinGecko.56.json',
    suffixes: [/\s+\(bStocks Tokenized Stock\)\s*$/i],
    name: 'bStocks',
    description:
      'Identified as a bStocks asset by the configured CoinGecko list. This label does not guarantee trading eligibility or settlement.',
  },
  {
    id: 'reality',
    chainId: SupportedChainId.ARBITRUM_ONE,
    source: 'https://files.cow.fi/token-lists/CoinGecko.42161.json',
    suffixes: [/\s+\(Reality Protocol\)\s*$/i, /\s+rStock\s*$/i],
    name: 'Reality',
    description:
      'Identified as a Reality asset by the configured CoinGecko list. This label does not guarantee trading eligibility or settlement.',
  },
] as const
