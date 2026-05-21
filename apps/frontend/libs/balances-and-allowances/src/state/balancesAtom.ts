import { atom } from 'jotai'
import { atomWithReset, atomWithStorage } from 'jotai/utils'

import { getJotaiMergerStorage, withStorageGuard } from '@cowprotocol/core'
import { mapSupportedNetworks, SupportedChainId } from '@cowprotocol/cow-sdk'
import { PersistentStateByChain } from '@cowprotocol/types'

import { Erc20MulticallState } from '../types'

export interface BalancesState extends Erc20MulticallState {
  chainId: SupportedChainId | null
  fromCache: boolean
  hasFirstLoad: boolean
  error: string | null
}
type Account = string

type BalancesCache = PersistentStateByChain<Record<Account, Record<TokenAddress, string>>>

type TokenAddress = string

export const DEFAULT_BALANCES_STATE: BalancesState = {
  isLoading: false,
  values: {},
  chainId: null,
  fromCache: false,
  hasFirstLoad: false,
  error: null,
}

// Persisted-state trust boundary: the merger storage previously spread any
// localStorage blob into the chain-keyed initial object — letting a malformed
// (browser-extension / schema-drift) blob smuggle non-object values into
// per-chain slots. Downstream consumers iterate
// `Object.entries(cache[chainId])` and call `BigInt(value)` on the leaf
// strings → both crash on bad shape. Phase 4 audit DoS-class finding.
//
// Validator is loose-on-purpose: we only require the top level to be a plain
// object whose values are also plain objects (or empty). Deep validation of
// the leaf `string` (BigInt-parseable) is the BalancesCacheUpdater's job;
// here we only defend against shape mismatches that crash before consumers
// can fall back.
function isValidBalancesCache(value: unknown): value is BalancesCache {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  for (const v of Object.values(value as Record<string, unknown>)) {
    if (v === undefined || v === null) continue
    if (typeof v !== 'object' || Array.isArray(v)) return false
  }
  return true
}

export const balancesCacheAtom = atomWithStorage<BalancesCache>(
  'balancesCacheAtom:v1',
  mapSupportedNetworks({}),
  withStorageGuard<BalancesCache>(getJotaiMergerStorage<BalancesCache>(), isValidBalancesCache, 'balancesCacheAtom:v1'),
)

export const balancesAtom = atomWithReset<BalancesState>(DEFAULT_BALANCES_STATE)

export const balancesUpdateAtom = atom<PersistentStateByChain<Record<string, number | undefined>>>(
  mapSupportedNetworks({}),
)

export const tradeSpenderAtom = atom<string | undefined>(undefined)
