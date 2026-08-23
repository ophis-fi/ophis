import { withTimeout } from '@cowprotocol/common-utils'

const OTC_ALLOWANCE_REFRESH_TIMEOUT_MS = 5_000
const OTC_PREFLIGHT_TIMEOUT_MS = 30_000

export function withOtcAllowanceRefreshTimeout<T>(refresh: () => Promise<T>): Promise<T> {
  return withTimeout(
    Promise.resolve().then(refresh),
    OTC_ALLOWANCE_REFRESH_TIMEOUT_MS,
    'Ophis OTC allowance refresh timed out',
  )
}

export function withOtcPreflightTimeout<T>(preflight: Promise<T>): Promise<T> {
  return withTimeout(preflight, OTC_PREFLIGHT_TIMEOUT_MS, 'Ophis OTC transaction preflight timed out')
}
