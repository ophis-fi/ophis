import { atom } from 'jotai'
import { atomWithStorage } from 'jotai/utils'

import { getJotaiIsolatedStorage } from '@cowprotocol/core'
import { mapSupportedNetworks } from '@cowprotocol/cow-sdk'
import type { BridgeOrderDataSerialized, PersistentStateByChainAccount } from '@cowprotocol/types'
import { BridgeOrderData } from '@cowprotocol/types'

import {
  bridgeOrdersStateSerializer,
  deserializeQuoteAmounts,
  serializeQuoteAmounts,
} from './bridgeOrdersStateSerializer'

export type BridgeOrdersStateSerialized<T = BridgeOrderDataSerialized[]> = PersistentStateByChainAccount<T>
export type BridgeOrdersState = BridgeOrdersStateSerialized<BridgeOrderData[]>

export const bridgeOrdersStoreAtom = atomWithStorage<BridgeOrdersStateSerialized>(
  'bridgeOrdersAtom:v1',
  mapSupportedNetworks({}),
  getJotaiIsolatedStorage(),
)

function deserializeState(state: BridgeOrdersStateSerialized): BridgeOrdersState {
  return bridgeOrdersStateSerializer(state, (order) => {
    // Drop orders whose quoteAmounts can't be deserialized — see
    // bridgeOrdersStateSerializer.ts for the threat-model comment.
    // A null return tells the serializer to skip this entry.
    const quoteAmounts = deserializeQuoteAmounts(order.quoteAmounts)
    if (quoteAmounts === null) return null
    return {
      ...order,
      quoteAmounts,
    }
  })
}

/**
 * Since BridgeOrderData contains CurrencyAmount, we have to serialize/deserialize it
 * For that we use bridgeOrdersStateSerializer
 */
export const bridgeOrdersAtom = atom<
  BridgeOrdersState,
  [BridgeOrdersState | ((state: BridgeOrdersState) => BridgeOrdersState)],
  BridgeOrdersStateSerialized
>(
  (get) => {
    return deserializeState(get(bridgeOrdersStoreAtom))
  },
  (get, set, updater) => {
    const update = typeof updater === 'function' ? updater(deserializeState(get(bridgeOrdersStoreAtom))) : updater

    const newState = bridgeOrdersStateSerializer(update, (order) => {
      return {
        ...order,
        quoteAmounts: serializeQuoteAmounts(order.quoteAmounts),
      }
    })

    set(bridgeOrdersStoreAtom, newState)

    return newState
  },
)
