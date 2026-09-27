import { DEFAULT_BACKOFF_OPTIONS, OrderBookApiError } from '@cowprotocol/cow-sdk'

export function retryOrderBookRequest(
  error: unknown,
  attempt: number,
  arcOrderbookUrl: string | undefined,
): boolean | Promise<boolean> {
  if (
    arcOrderbookUrl &&
    error instanceof OrderBookApiError &&
    error.response.url.startsWith(`${arcOrderbookUrl}/`) &&
    (error.response.status === 429 ||
      attempt >= 3 ||
      (error.response.url === `${arcOrderbookUrl}/api/v1/quote` && error.response.status >= 500))
  ) {
    // RPC exhaustion also surfaces as 5xx. Let normal quote polling recover without a retry burst.
    return false
  }
  return DEFAULT_BACKOFF_OPTIONS.retry?.(error, attempt) ?? true
}
