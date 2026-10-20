/**
 * Referral code creation, sharing, and attribution totals for the Profile page.
 * Partners see their assigned code and a link to the signed referee breakdown.
 */
import { useSetAtom } from 'jotai'
import { Dispatch, ReactNode, SetStateAction, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

import { useCopyClipboard } from '@cowprotocol/common-hooks'
import { areAddressesEqual, getAddressKey } from '@cowprotocol/cow-sdk'

import { Callout, InlineCode, KeyValueList, MetricCard, Section } from 'ophis/ds'

import { ActionButton, GhostButton, MetricRow, ShareRow } from 'pages/Affiliate/Affiliate.styled'

import { PartnerAffiliateSummary } from './PartnerAffiliateSummary'

import { useOphisAffiliateSign } from '../hooks/useOphisAffiliateSign'
import { type AffiliateStats, AffiliateApiError, createRefCode, getAffiliateStats } from '../lib/ophisAffiliateApi'
import { setAffiliateOwnCodeAtom } from '../state/affiliateOwnCodeAtom'

const SHARE_ORIGIN = 'https://swap.ophis.fi'

function shareLink(code: string): string {
  return `${SHARE_ORIGIN}/?ref=${code}`
}

function formatUsd(value: number): string {
  if (!Number.isFinite(value)) return '$0'
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(value)
}

type CreateState = 'idle' | 'signing' | 'creating' | 'rejected' | 'error'

interface Props {
  account: string
}

interface AffiliateDashboardState {
  loadError: boolean
  loading: boolean
  setStats: Dispatch<SetStateAction<AffiliateStats | null>>
  stats: AffiliateStats | null
}

function useAffiliateDashboardState(account: string): AffiliateDashboardState {
  const [stats, setStats] = useState<AffiliateStats | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState(false)

  const loadStats = useCallback((wallet: string, signal: { cancelled: boolean }) => {
    setLoading(true)
    setLoadError(false)
    getAffiliateStats(wallet)
      .then((data) => {
        if (!signal.cancelled) setStats(data)
      })
      .catch((error: unknown) => {
        if (signal.cancelled) return
        // A 404 (wallet has never been an affiliate) is a normal empty state,
        // not an error: render the "create your code" path with zeroed stats.
        if (error instanceof AffiliateApiError && error.status === 404) {
          setStats(null)
        } else {
          setLoadError(true)
        }
      })
      .finally(() => {
        if (!signal.cancelled) setLoading(false)
      })
  }, [])

  useEffect(() => {
    const signal = { cancelled: false }
    loadStats(account, signal)
    return () => {
      signal.cancelled = true
    }
  }, [account, loadStats])

  return { loadError, loading, setStats, stats }
}

interface CreateAffiliateCodeState {
  createState: CreateState
  onCreate: () => Promise<void>
}

function useCreateAffiliateCode(
  account: string,
  setStats: Dispatch<SetStateAction<AffiliateStats | null>>,
): CreateAffiliateCodeState {
  const sign = useOphisAffiliateSign(account)
  const [createState, setCreateState] = useState<CreateState>('idle')

  // Latest connected account, for guarding async continuations: a wallet
  // switch mid-sign/mid-request must not render the OLD wallet's minted code
  // under the NEW wallet's dashboard.
  const accountRef = useRef(account)
  useLayoutEffect(() => {
    accountRef.current = account
  }, [account])

  // A GENUINE wallet switch resets the mint state machine (a stale in-flight
  // create or error/rejected state would otherwise mislabel the new wallet's
  // button). Key on the canonical address key so a checksum-only re-emit of
  // the SAME wallet does NOT reset mid-signature -- otherwise the reset
  // re-enables the button and the user can fire a duplicate createRefCode
  // (Codex review).
  const accountKey = getAddressKey(account)
  useEffect(() => {
    setCreateState('idle')
  }, [accountKey])

  const onCreate = useCallback(async () => {
    // Pin the flow to the wallet that started it. If the account changes
    // during any await, the account-change effect has already reset state for
    // the NEW wallet, so a stale continuation must bail WITHOUT touching state
    // (including the 'creating' transition and the catch path) — otherwise it
    // strands the new wallet on a "Creating..."/error label (Codex review).
    const startAccount = account
    setCreateState('signing')
    try {
      const body = await sign('create referral code')
      if (!areAddressesEqual(accountRef.current, startAccount)) return
      setCreateState('creating')
      const res = await createRefCode(body)
      if (!areAddressesEqual(accountRef.current, startAccount)) return
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
      if (!areAddressesEqual(accountRef.current, startAccount)) return
      // User-rejected signature (ethers v5 ACTION_REJECTED / EIP-1193 4001).
      const code = (error as { code?: number | string })?.code
      if (code === 4001 || code === 'ACTION_REJECTED') {
        setCreateState('rejected')
      } else {
        setCreateState('error')
      }
    }
  }, [account, setStats, sign])

  return { createState, onCreate }
}

interface ReferralStatusSectionProps {
  loadError: boolean
  loading: boolean
  stats: AffiliateStats | null
}

function ReferralStatusSection({ loadError, loading, stats }: ReferralStatusSectionProps): ReactNode {
  let content: ReactNode
  if (loading) {
    content = <p>Loading your referral status...</p>
  } else if (loadError) {
    content = (
      <Callout tone="warning" title="Could not load your status">
        <p>The affiliate service did not respond. Refresh the page to try again.</p>
      </Callout>
    )
  } else {
    content = (
      <>
        <MetricRow>
          <MetricCard label="Referred wallets" value={stats?.referredCount ?? 0} compact />
          <MetricCard
            label="Referred volume"
            value={formatUsd(stats?.currentCycleVolumeUsd ?? 0)}
            sublabel="this month"
            compact
          />
        </MetricRow>
      </>
    )
  }

  return (
    <Section id="referral" title="Referrals">
      {content}
    </Section>
  )
}

interface ReferralCodeSectionProps {
  activeCode?: string
  copy: (value: string) => void
  createState: CreateState
  isCopied: boolean
  onCreate: () => Promise<void>
}

function ReferralCodeSection({
  activeCode,
  copy,
  createState,
  isCopied,
  onCreate,
}: ReferralCodeSectionProps): ReactNode {
  return (
    <Section id="referral-code" title="Your referral code">
      {activeCode ? (
        <>
          <KeyValueList
            items={[
              { label: 'Code', value: <InlineCode>{activeCode}</InlineCode> },
              { label: 'Share link', value: <InlineCode>{shareLink(activeCode)}</InlineCode> },
            ]}
          />
          <ShareRow>
            <GhostButton type="button" onClick={() => copy(shareLink(activeCode))}>
              {isCopied ? 'Copied' : 'Copy share link'}
            </GhostButton>
          </ShareRow>
        </>
      ) : (
        <CreateReferralCodeContent createState={createState} onCreate={onCreate} />
      )}
      <p>
        Share your referral link so new wallets can activate your code. View your referred wallet count and volume
        above.
      </p>
    </Section>
  )
}

function CreateReferralCodeContent({
  createState,
  onCreate,
}: Pick<ReferralCodeSectionProps, 'createState' | 'onCreate'>): ReactNode {
  const isCreating = createState === 'signing' || createState === 'creating'
  const buttonLabel =
    createState === 'signing'
      ? 'Confirm in your wallet...'
      : createState === 'creating'
        ? 'Creating...'
        : 'Create your referral code'

  return (
    <>
      <p>
        You don&apos;t have an active code yet. Create one, it takes a single wallet signature (no transaction, no gas).
      </p>
      <ShareRow>
        <ActionButton type="button" onClick={onCreate} disabled={isCreating}>
          {buttonLabel}
        </ActionButton>
      </ShareRow>
      {createState === 'rejected' && (
        <Callout tone="warning" title="Signature cancelled">
          <p>You declined the signature. Click the button again when you&apos;re ready.</p>
        </Callout>
      )}
      {createState === 'error' && (
        <Callout tone="warning" title="Could not create your code">
          <p>Something went wrong. Please try again in a moment.</p>
        </Callout>
      )}
    </>
  )
}

export function OphisAffiliateDashboard({ account }: Props): ReactNode {
  const [isCopied, copy] = useCopyClipboard()
  const { loadError, loading, setStats, stats } = useAffiliateDashboardState(account)
  const { createState, onCreate } = useCreateAffiliateCode(account, setStats)

  const activeCode = stats?.activeCodes?.[0]
  // Cache the connected wallet's own code so the post-trade "share your swap"
  // tweet can embed it as ?ref= (turning every affiliate's swap into a referral
  // link) without a fresh signature. Placed before the partner early-return so
  // both regular and partner codes are captured; no-op for a wallet with none.
  const persistOwnCode = useSetAtom(setAffiliateOwnCodeAtom)
  useEffect(() => {
    if (activeCode) persistOwnCode(activeCode)
  }, [activeCode, persistOwnCode])

  // Partner-aware branch: a connected wallet whose own public stats report
  // kind === 'partner' gets the read-only partner summary, NOT the regular
  // mint-a-code flow (partners already have an assigned code). This only ever
  // renders for the connected wallet's own data, so a non-partner wallet never
  // sees partner UI. We still defer to the shared loading/error handling below.
  if (!loading && !loadError && stats?.kind === 'partner') {
    return <PartnerAffiliateSummary stats={stats} />
  }

  return (
    <>
      <ReferralStatusSection loadError={loadError} loading={loading} stats={stats} />

      {!loading && !loadError && (
        <ReferralCodeSection
          activeCode={activeCode}
          copy={copy}
          createState={createState}
          isCopied={isCopied}
          onCreate={onCreate}
        />
      )}
    </>
  )
}
