import { atomWithStorage } from 'jotai/utils'

import { getJotaiIsolatedStorage, withStorageGuard } from '@cowprotocol/core'

import type { TwapOrderItem } from 'modules/twap'

export type TwapOrdersList = { [key: string]: TwapOrderItem }

// Persisted-state trust boundary: a corrupted entry in this dict (browser
// extension or schema drift) previously crashed every consumer that iterated
// the values (`Object.values(...).map(o => o.order.sellToken)`). Phase 4
// audit DoS-class finding — drop the whole dict if it's not a plain
// object-of-objects. We don't validate TwapOrderItem field-by-field here
// because: (a) the strict shape is large and version-specific, (b) consumers
// already tolerate `undefined` field values via the partial-render path —
// the only fatal case is the WHOLE dict being mis-shaped.
function isPlainObjectDict(value: unknown): value is TwapOrdersList {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  for (const v of Object.values(value as Record<string, unknown>)) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return false
  }
  return true
}

const guardedStorage = withStorageGuard<TwapOrdersList>(
  getJotaiIsolatedStorage<TwapOrdersList>(),
  isPlainObjectDict,
  'twap-orders-list:v1',
)

export const twapOrdersAtom = atomWithStorage<TwapOrdersList>('twap-orders-list:v1', {}, guardedStorage)
