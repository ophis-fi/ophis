import { Dispatch, SetStateAction, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

import { useOphisAffiliateSign } from './useOphisAffiliateSign'

import { affiliateAddressKey } from '../lib/affiliateAddress'
import { type AffiliateStats, createRefCode } from '../lib/ophisAffiliateApi'

export type CreateState = 'idle' | 'signing' | 'creating' | 'rejected' | 'error'

interface CreateAffiliateCodeState {
  createState: CreateState
  onCreate: (payoutWallet?: string) => Promise<void>
}

export function useCreateAffiliateCode(
  account: string,
  setStats: Dispatch<SetStateAction<AffiliateStats | null>>,
): CreateAffiliateCodeState {
  const sign = useOphisAffiliateSign(account)
  const [createState, setCreateState] = useState<CreateState>('idle')

  const accountKey = affiliateAddressKey(account)
  const accountRevision = useRef(0)
  useLayoutEffect(
    () => () => {
      ++accountRevision.current
    },
    [accountKey],
  )

  useEffect(() => {
    setCreateState('idle')
  }, [accountKey])

  const onCreate = useCallback(
    async (payoutWallet?: string) => {
      // Pin the flow to the wallet that started it. If the account changes
      // during any await, the account-change effect has already reset state for
      // the NEW wallet, so a stale continuation must bail WITHOUT touching state
      // (including the 'creating' transition and the catch path) — otherwise it
      // strands the new wallet on a "Creating..."/error label (Codex review).
      const revision = accountRevision.current
      const startAccount = account
      setCreateState('signing')
      try {
        const body = await sign(
          payoutWallet ? `create referral code\nWETH payout: ${payoutWallet}` : 'create referral code',
        )
        if (accountRevision.current !== revision) return
        setCreateState('creating')
        const res = await createRefCode(payoutWallet ? { ...body, payoutWallet } : body)
        if (accountRevision.current !== revision) return
        setStats((prev) =>
          prev
            ? { ...prev, activeCodes: [res.code, ...prev.activeCodes.filter((c) => c !== res.code)] }
            : {
                wallet: startAccount,
                kind: 'regular',
                activeCodes: [res.code],
                referredCount: 0,
                currentCycleVolumeUsd: 0,
                lifetimeReferredVolumeUsd: 0,
              },
        )
        setCreateState('idle')
      } catch (error: unknown) {
        if (accountRevision.current !== revision) return
        // User-rejected signature (ethers v5 ACTION_REJECTED / EIP-1193 4001).
        const code = (error as { code?: number | string })?.code
        if (code === 4001 || code === 'ACTION_REJECTED') {
          setCreateState('rejected')
        } else {
          setCreateState('error')
        }
      }
    },
    [account, setStats, sign],
  )

  return { createState, onCreate }
}
