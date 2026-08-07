import { useCallback, useEffect, useState } from 'react'

import { areAddressesEqual } from '@cowprotocol/common-utils'

import { claimTradeReward, getTradeRewardStatus, TradeRewardStatus } from 'modules/affiliate'

export interface TradeRewardState {
  readonly status: TradeRewardStatus | null
  readonly loading: boolean
  readonly claiming: boolean
  readonly error: string | null
  readonly claim: () => Promise<void>
}

export function useTradeReward(account: string | undefined): TradeRewardState {
  const [status, setStatus] = useState<TradeRewardStatus | null>(null)
  const [loading, setLoading] = useState(Boolean(account))
  const [claiming, setClaiming] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    if (!account) return
    const result = await getTradeRewardStatus(account)
    if (areAddressesEqual(result.wallet, account)) setStatus(result)
  }, [account])

  useEffect(() => {
    let active = true
    setStatus(null)
    setError(null)
    setLoading(Boolean(account))
    if (!account)
      return () => {
        active = false
      }
    getTradeRewardStatus(account)
      .then((result) => {
        if (active && areAddressesEqual(result.wallet, account)) setStatus(result)
      })
      .catch(() => {
        if (active) setError('The rewards service is temporarily unavailable.')
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [account])

  const claim = useCallback(async (): Promise<void> => {
    if (!account || claiming) return
    setClaiming(true)
    setError(null)
    try {
      await claimTradeReward(account)
      await refresh()
    } catch {
      setError('The sponsored claim could not be completed. Please try again.')
    } finally {
      setClaiming(false)
    }
  }, [account, claiming, refresh])

  return { status, loading, claiming, error, claim }
}
