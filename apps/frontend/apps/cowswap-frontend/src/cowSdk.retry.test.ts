import { OrderBookApiError } from '@cowprotocol/cow-sdk'

import { retryOrderBookRequest } from './cowSdk.retry'

const ARC_URL = 'https://arc-mainnet.ophis.fi'

function failure(status: number, url = `${ARC_URL}/api/v1/quote`): OrderBookApiError {
  const response = new Response('', { status })
  Object.defineProperty(response, 'url', { value: url })
  return new OrderBookApiError(response, '')
}

it('does not amplify Arc rate limits with automatic retries', () => {
  expect(retryOrderBookRequest(failure(429), 1, ARC_URL)).toBe(false)
})

it.each([500, 502, 503, 504])('does not immediately retry Arc quote failures with HTTP %i', (status) => {
  expect(retryOrderBookRequest(failure(status), 1, ARC_URL)).toBe(false)
})

it('bounds Arc HTTP recovery and preserves other chain policies', () => {
  const ordersUrl = 'https://arc-mainnet.ophis.fi/api/v1/orders'
  expect(retryOrderBookRequest(failure(503, ordersUrl), 1, ARC_URL)).toBe(true)
  expect(retryOrderBookRequest(failure(503, ordersUrl), 3, ARC_URL)).toBe(false)
  expect(retryOrderBookRequest(failure(400), 1, ARC_URL)).toBe(false)
  expect(retryOrderBookRequest(failure(429, 'https://api.cow.fi/mainnet/api/v1/quote'), 1, ARC_URL)).toBe(true)
  expect(retryOrderBookRequest(failure(503, 'https://api.cow.fi/mainnet/api/v1/quote'), 1, ARC_URL)).toBe(true)
  expect(retryOrderBookRequest(failure(503, 'https://arc-mainnet.ophis.fi.invalid/api/v1/quote'), 1, ARC_URL)).toBe(
    true,
  )
})

it('uses the effective Arc override without changing other endpoints', () => {
  const override = 'https://orderbook.example/arc'
  expect(retryOrderBookRequest(failure(503, `${override}/api/v1/quote`), 1, override)).toBe(false)
  expect(retryOrderBookRequest(failure(503, `${override}/api/v1/orders`), 1, override)).toBe(true)
  expect(retryOrderBookRequest(failure(503), 1, override)).toBe(true)
  expect(retryOrderBookRequest(failure(503), 1, undefined)).toBe(true)
})
