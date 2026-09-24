import { ARC_ENABLED, ARC_ORDERBOOK_URL } from '@cowprotocol/common-const'
import { DEFAULT_BACKOFF_OPTIONS, OrderBookApiError } from '@cowprotocol/cow-sdk'

export function retryOrderBookRequest(error: unknown, attempt: number): boolean | Promise<boolean> {
  if (
    ARC_ENABLED &&
    error instanceof OrderBookApiError &&
    error.response.url.startsWith(`${ARC_ORDERBOOK_URL}/`) &&
    (error.response.status === 429 || attempt >= 3)
  ) {
    // A rejected Arc quote must not keep competing with newer quotes for the same quota.
    return false
  }
  return DEFAULT_BACKOFF_OPTIONS.retry?.(error, attempt) ?? true
}
