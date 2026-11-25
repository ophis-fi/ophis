import { atom } from 'jotai'
import { atomWithStorage } from 'jotai/utils'

import { walletInfoAtom } from '@cowprotocol/wallet'

import { AFFILIATE_OWN_CODE_STORAGE_KEY } from '../config/affiliateProgram.const'
import { affiliateAddressKey } from '../lib/affiliateAddress'

/** The post-trade share link reuses the referral code from this wallet's dashboard. */
const affiliateOwnCodeByWalletAtom = atomWithStorage<Record<string, string | undefined>>(
  AFFILIATE_OWN_CODE_STORAGE_KEY,
  {},
  undefined,
  { getOnInit: true },
)

export const setAffiliateOwnCodeAtom = atom(
  null,
  (_get, set, { account, code }: { account: string; code: string | undefined }) => {
    const key = affiliateAddressKey(account)

    set(affiliateOwnCodeByWalletAtom, (prev) => {
      if (!code) {
        const { [key]: _deleted, ...rest } = prev
        return rest
      }
      return { ...prev, [key]: code }
    })
  },
)

export const affiliateOwnCodeAtom = atom<string | undefined>((get) => {
  const { account } = get(walletInfoAtom)
  if (!account) return undefined
  return get(affiliateOwnCodeByWalletAtom)[affiliateAddressKey(account)]
})
