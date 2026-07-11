import { getAddressKey } from '@cowprotocol/cow-sdk'

import { atom } from 'jotai'
import { atomWithStorage } from 'jotai/utils'

/**
 * refBoundWalletsAtom — local memo of which (wallet, code) pairs have already
 * been bound via POST /ref/bind, so the RefCodeCaptureUpdater does not retry
 * the bind on every render / navigation.
 *
 * Terminal-success cases (200 bound, `alreadyBound: true`, and the 409
 * not-net-new rejection) all mark the pair bound here: there is no value in
 * re-POSTing any of them.
 *
 * This is a pure-localStorage memo with no BFF dependency. The key is
 * `${wallet}:${code}` lowercased so a wallet switching codes is tracked
 * independently.
 */
const REF_BOUND_WALLETS_STORAGE_KEY = 'ophis:affiliateRefBoundWallets:v0'

const refBoundWalletsByKeyAtom = atomWithStorage<Record<string, true | undefined>>(
  REF_BOUND_WALLETS_STORAGE_KEY,
  {},
  undefined,
  { getOnInit: true },
)

function boundKey(wallet: string, code: string): string {
  // Address via getAddressKey (canonical, lowercased) per AGENTS.md; the ref
  // code is not an address, so it keeps its own case normalization. Both are
  // byte-identical to the previous lowercasing, so stored keys still match.
  return `${getAddressKey(wallet)}:${code.toLowerCase()}`
}

export const isRefBoundAtom = atom((get) => {
  const map = get(refBoundWalletsByKeyAtom)
  return (wallet: string, code: string): boolean => Boolean(map[boundKey(wallet, code)])
})

export const markRefBoundAtom = atom(null, (_get, set, payload: { wallet: string; code: string }) => {
  set(refBoundWalletsByKeyAtom, (prev) => ({
    ...prev,
    [boundKey(payload.wallet, payload.code)]: true,
  }))
})
