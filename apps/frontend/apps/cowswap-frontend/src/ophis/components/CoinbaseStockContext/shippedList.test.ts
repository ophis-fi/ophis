import { validateTokenList } from '@cowprotocol/tokens'
import type { TokenList } from '@uniswap/token-lists'

import shippedList from '../../../../public/token-lists/coinbase-tokenized-stocks.json'

// The list is fetched at runtime through fetchTokenList -> validateTokenList (Uniswap schema
// with the Ophis symbol/name patches). A schema miss there fails SILENTLY for users: the list
// never loads and CoinGecko's AAPLC entry wins. Validate the shipped file the same way.
describe('shipped Coinbase tokenized-stocks list', () => {
  it('passes the runtime token-list validator', async () => {
    await expect(validateTokenList(shippedList as TokenList)).resolves.toBe(shippedList)
  })

  it('tags every token with the coinbase provider tag the selector trusts', () => {
    expect(shippedList.tokens).toHaveLength(13)
    for (const token of shippedList.tokens) {
      expect(token.chainId).toBe(8453)
      expect(token.decimals).toBe(8)
      expect(token.tags).toEqual(['coinbase'])
    }
    expect(shippedList.tags.coinbase).toBeDefined()
  })
})
