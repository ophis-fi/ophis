import { atom } from 'jotai'
import { atomWithStorage, createJSONStorage } from 'jotai/utils'

import { withStorageGuard } from '@cowprotocol/core'

// Persisted-state trust boundary: this atom's previous shape was a plain
// `atomWithStorage<string[]>`. Browser-extension corruption or schema drift
// could leave non-array / mixed-type data in localStorage. Downstream code
// calls `.filter()` and `[...orderIds, ...]` on the result — both crash if
// the storage value is not a string[]. Phase 4 audit DoS-class finding.
function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string')
}

const guardedStorage = withStorageGuard<string[]>(
  createJSONStorage<string[]>(() => localStorage),
  isStringArray,
  'eth-flow-in-flight-order-ids:v0',
)

export const ethFlowInFlightOrderIdsAtom = atomWithStorage<string[]>(
  'eth-flow-in-flight-order-ids:v0',
  [],
  guardedStorage,
)

export const addInFlightOrderIdAtom = atom(null, (get, set, orderId: string) => {
  const orderIds = get(ethFlowInFlightOrderIdsAtom)

  set(ethFlowInFlightOrderIdsAtom, [...orderIds, orderId])
})

export const removeInFlightOrderIdAtom = atom(null, (get, set, orderId: string) => {
  const orderIds = get(ethFlowInFlightOrderIdsAtom)

  set(
    ethFlowInFlightOrderIdsAtom,
    orderIds.filter((order) => order !== orderId),
  )
})
