import { ARC_ENABLED, ARC_ORDERBOOK_URL } from '@cowprotocol/common-const'
import { DEFAULT_BACKOFF_OPTIONS, OrderBookApiError } from '@cowprotocol/cow-sdk'

export function retryOrderBookRequest(error: unknown, attempt: number): boolean | Promise<boolean> {
  if (
    ARC_ENABLED &&
    error instanceof OrderBookApiError &&
    error.response.url.startsWith(`${ARC_ORDERBOOK_URL}/`) &&
    (error.response.status === 429 ||
      attempt >= 3 ||
      (error.response.url === `${ARC_ORDERBOOK_URL}/api/v1/quote` && error.response.status >= 500))
  ) {
    // RPC exhaustion also surfaces as 5xx. Let normal quote polling recover without a retry burst.
    return false
  }
  return DEFAULT_BACKOFF_OPTIONS.retry?.(error, attempt) ?? true
}
