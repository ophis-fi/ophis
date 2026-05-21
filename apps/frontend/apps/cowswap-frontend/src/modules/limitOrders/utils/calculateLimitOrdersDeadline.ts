import { Timestamp } from 'types'

import { LimitOrdersSettingsState } from 'modules/limitOrders/state/limitOrdersSettingsAtom'
import { TradeQuoteState, getOrderValidTo } from 'modules/tradeQuote'

// Persisted-state trust boundary (audit 2026-05-21). `LimitOrdersSettingsState`
// is hydrated from localStorage via Jotai's atomWithStorage. The
// `customDeadlineTimestamp` field is typed `Timestamp | null` but the
// runtime value is whatever an extension or shared-machine tamperer
// chose to write. A truthy-but-non-number (e.g. the string
// "99999999999999") would land in this function and pass straight
// through to `validTo` in the EIP-712 GPv2Order digest the user
// signs — extending the cancel window of orders the user thought
// they were placing with a 30min expiry.
//
// Guards: typeof number + finite + within a sane range
// (positive Unix timestamp + ≤1 year out). Reject anything else →
// fall through to the default deadline path.
const MAX_DEADLINE_SECONDS_FROM_NOW = 365 * 24 * 60 * 60 // 1 year
function isValidCustomDeadline(value: unknown): value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return false
  const nowSec = Math.floor(Date.now() / 1000)
  return value > nowSec && value <= nowSec + MAX_DEADLINE_SECONDS_FROM_NOW
}

export function calculateLimitOrdersDeadline(
  settingsState: LimitOrdersSettingsState,
  quoteState: TradeQuoteState,
): Timestamp {
  if (isValidCustomDeadline(settingsState.customDeadlineTimestamp)) {
    return settingsState.customDeadlineTimestamp
  }
  return getOrderValidTo(settingsState.deadlineMilliseconds / 1000, quoteState)
}
