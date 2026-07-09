import { useEffect, useState } from 'react'

import { areAddressesEqual } from '@cowprotocol/cow-sdk'

import { getWalletXp, WalletXp } from 'modules/affiliate'

export interface WalletXpState {
  data: WalletXp | null
  loading: boolean
  error: boolean
}

/**
 * Fetches the connected wallet's XP from the public rebate indexer.
 * Same cancellation idiom as OphisAffiliateDashboard: a mutable flag
 * (not AbortController) so a late response never lands on a newer wallet.
 */
export function useWalletXp(account: string | undefined): WalletXpState {
  const [data, setData] = useState<WalletXp | null>(null)
  // Initialize as loading when a wallet is already connected so the first
  // frame renders the loading branch, never a false "0 XP".
  const [loading, setLoading] = useState(Boolean(account))
  const [error, setError] = useState(false)

  useEffect(() => {
    // Drop the previous wallet's XP immediately on any account change:
    // eligibility must never be derived from another account's balance,
    // neither while the new fetch is in flight nor after it fails (Codex
    // post-merge review).
    setData(null)
    setError(false)
    if (!account) return
    const signal = { cancelled: false }
    setLoading(true)
    getWalletXp(account)
      .then((res) => {
        // The endpoint echoes the queried wallet; accept only a response for
        // the account this effect ran for.
        if (!signal.cancelled && areAddressesEqual(res.wallet, account)) setData(res)
      })
      .catch(() => {
        if (!signal.cancelled) setError(true)
      })
      .finally(() => {
        if (!signal.cancelled) setLoading(false)
      })
    return () => {
      signal.cancelled = true
    }
  }, [account])

  // Gate the returned data by the CURRENT account at read time, not just via
  // the clearing effect above. On an A->B switch React renders once with B's
  // account while A's data is still in state (effects run after that render),
  // so a read-time match is what prevents B from ever deriving eligibility
  // from A's XP for that frame (Codex post-merge review).
  const scopedData = data && account && areAddressesEqual(data.wallet, account) ? data : null

  return { data: scopedData, loading, error }
}
