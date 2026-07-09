import { atom } from 'jotai'
import { atomWithStorage } from 'jotai/utils'

import { walletInfoAtom } from '@cowprotocol/wallet'

import {
  AFFILIATE_PENDING_REF_CODE_STORAGE_KEY,
  AFFILIATE_TRADER_SAVED_CODES_STORAGE_KEY,
} from '../config/affiliateProgram.const'

export interface AffiliateTraderSavedCodeState {
  /**
   * Persisted referral code for trader flows, stored after verification success or recovery.
   */
  savedCode?: string
  /**
   * Persisted linkage flag set when code is recovered from trader's fulfilled orders.
   */
  isLinked?: boolean
}

const affiliateTraderSavedCodeByWalletAtom = atomWithStorage<Record<string, AffiliateTraderSavedCodeState | undefined>>(
  AFFILIATE_TRADER_SAVED_CODES_STORAGE_KEY,
  {},
  undefined,
  { getOnInit: true },
)

/**
 * Wallet-independent holding slot for a `?ref=` code captured BEFORE any
 * wallet is connected. The referral share-link audience is by definition
 * net-new (the backend rejects binds from wallets with trade history), so
 * the common flow is: open link with no wallet -> URL param is stripped ->
 * connect later. Without this slot the code was silently dropped in that
 * flow and the referrer never got credit; the first wallet to connect now
 * claims it (RefCodeCaptureUpdater promotes it into the per-wallet bucket).
 */
export const affiliatePendingRefCodeAtom = atomWithStorage<string | undefined>(
  AFFILIATE_PENDING_REF_CODE_STORAGE_KEY,
  undefined,
  undefined,
  { getOnInit: true },
)

export const setAffiliateTraderSavedCodeAtom = atom(
  null,
  (get, set, nextState: AffiliateTraderSavedCodeState | undefined) => {
    const { account } = get(walletInfoAtom)
    if (!account) {
      // No wallet yet: park the captured code in the pending slot so it
      // survives the URL strip + navigation + reload until a wallet connects.
      set(affiliatePendingRefCodeAtom, nextState?.savedCode)
      return
    }

    set(affiliateTraderSavedCodeByWalletAtom, (prev) => {
      if (!nextState) {
        const { [account]: _deleted, ...rest } = prev
        return rest
      }

      return {
        ...prev,
        [account]: nextState,
      }
    })
  },
)

export const affiliateTraderSavedCodeAtom = atom<AffiliateTraderSavedCodeState>((get) => {
  const { account } = get(walletInfoAtom)
  const storedStateByWallet = get(affiliateTraderSavedCodeByWalletAtom)
  const storedState = account ? storedStateByWallet[account] : undefined
  return storedState ?? {}
})
