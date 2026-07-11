import { atom } from 'jotai'
import { atomWithStorage } from 'jotai/utils'

import { getAddressKey } from '@cowprotocol/cow-sdk'
import { walletInfoAtom } from '@cowprotocol/wallet'

import { AFFILIATE_OWN_CODE_STORAGE_KEY } from '../config/affiliateProgram.const'

/**
 * The connected wallet's OWN referral code (its `activeCodes[0]`), cached per
 * wallet so a later trade can turn its "share your swap" post into a
 * referral-attributed link (`?ref=<code>`) WITHOUT a fresh signature.
 *
 * The code is only known after the wallet signs on the affiliate/rewards page
 * (sig-gated), and it is held there in component state, not globally. This atom
 * persists it (keyed by `getAddressKey`, so the key is checksum-insensitive and
 * matches the dashboard's own keying) once the dashboard has it, so the
 * post-trade share surface can read it. A wallet with no code has no entry, and
 * the share falls back to the plain link.
 */
const affiliateOwnCodeByWalletAtom = atomWithStorage<Record<string, string | undefined>>(
  AFFILIATE_OWN_CODE_STORAGE_KEY,
  {},
  undefined,
  { getOnInit: true },
)

export const setAffiliateOwnCodeAtom = atom(null, (get, set, code: string | undefined) => {
  const { account } = get(walletInfoAtom)
  if (!account) return
  const key = getAddressKey(account)

  set(affiliateOwnCodeByWalletAtom, (prev) => {
    if (!code) {
      const { [key]: _deleted, ...rest } = prev
      return rest
    }
    return { ...prev, [key]: code }
  })
})

export const affiliateOwnCodeAtom = atom<string | undefined>((get) => {
  const { account } = get(walletInfoAtom)
  if (!account) return undefined
  return get(affiliateOwnCodeByWalletAtom)[getAddressKey(account)]
})
