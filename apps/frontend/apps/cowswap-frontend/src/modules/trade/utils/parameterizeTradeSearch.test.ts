import { OrderKind } from '@cowprotocol/cow-sdk'

import { parameterizeTradeSearch } from './parameterizeTradeSearch'

import { TRADE_URL_BUY_AMOUNT_KEY, TRADE_URL_SELL_AMOUNT_KEY } from '../const/tradeUrl'

it('removes both amounts only when explicitly cleared', () => {
  const search = `${TRADE_URL_SELL_AMOUNT_KEY}=123&${TRADE_URL_BUY_AMOUNT_KEY}=456&keep=value`
  const cleared = new URLSearchParams(parameterizeTradeSearch(search, { kind: OrderKind.SELL, amount: '' }))
  expect(cleared.has(TRADE_URL_SELL_AMOUNT_KEY)).toBe(false)
  expect(cleared.has(TRADE_URL_BUY_AMOUNT_KEY)).toBe(false)
  expect(cleared.get('keep')).toBe('value')
  const unchanged = new URLSearchParams(parameterizeTradeSearch(search))
  expect(unchanged.get(TRADE_URL_SELL_AMOUNT_KEY)).toBe('123')
  expect(unchanged.get(TRADE_URL_BUY_AMOUNT_KEY)).toBe('456')
})

it('removes stale recipient URL state only when clearing the recipient', () => {
  const search = 'recipient=alice.eth&recipientAddress=0x123&keep=value'
  const cleared = new URLSearchParams(parameterizeTradeSearch(search, { clearRecipient: true }))
  expect(cleared.has('recipient')).toBe(false)
  expect(cleared.has('recipientAddress')).toBe(false)
  expect(cleared.get('keep')).toBe('value')
  expect(parameterizeTradeSearch(search)).toBe(search)
})
