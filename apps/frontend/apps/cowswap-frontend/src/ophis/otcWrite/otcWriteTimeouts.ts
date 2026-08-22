import { withTimeout } from '@cowprotocol/common-utils'

const OTC_ALLOWANCE_REFRESH_TIMEOUT_MS = 5_000

export function withOtcAllowanceRefreshTimeout<T>(refresh: () => Promise<T>): Promise<T> {
  return withTimeout(
    Promise.resolve().then(refresh),
    OTC_ALLOWANCE_REFRESH_TIMEOUT_MS,
    'Ophis OTC allowance refresh timed out',
  )
}
