import { OrderBookApiError } from '@cowprotocol/cow-sdk'

import { retryOrderBookRequest } from './cowSdk.retry'

jest.mock('@cowprotocol/common-const', () => ({
  ARC_ENABLED: true,
  ARC_ORDERBOOK_URL: 'https://arc-mainnet.ophis.fi',
}))

function failure(status: number, url = 'https://arc-mainnet.ophis.fi/api/v1/quote'): OrderBookApiError {
  const response = new Response('', { status })
  Object.defineProperty(response, 'url', { value: url })
  return new OrderBookApiError(response, '')
}

it('does not amplify Arc rate limits with automatic retries', () => {
  expect(retryOrderBookRequest(failure(429), 1)).toBe(false)
})

it('bounds Arc HTTP recovery and preserves other chain policies', () => {
  expect(retryOrderBookRequest(failure(503), 1)).toBe(true)
  expect(retryOrderBookRequest(failure(503), 3)).toBe(false)
  expect(retryOrderBookRequest(failure(400), 1)).toBe(false)
  expect(retryOrderBookRequest(failure(429, 'https://api.cow.fi/mainnet/api/v1/quote'), 1)).toBe(true)
})
