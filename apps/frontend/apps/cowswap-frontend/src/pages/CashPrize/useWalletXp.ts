import { useEffect, useState } from 'react'

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
    if (!account) {
      setData(null)
      return
    }
    const signal = { cancelled: false }
    setLoading(true)
    setError(false)
    getWalletXp(account)
      .then((res) => {
        if (!signal.cancelled) setData(res)
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

  return { data, loading, error }
}
