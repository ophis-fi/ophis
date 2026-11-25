/**
 * Referral code creation, sharing, and attribution totals for the Profile page.
 * Partners see their assigned code and a link to the signed referee breakdown.
 */
import { useSetAtom } from 'jotai'
import { Dispatch, ReactNode, SetStateAction, useCallback, useEffect, useState } from 'react'

import { useCopyClipboard } from '@cowprotocol/common-hooks'

import { constants, utils } from 'ethers'
import { Callout, InlineCode, KeyValueList, MetricCard, Section } from 'ophis/ds'

import { ActionButton, GhostButton, MetricRow, ShareRow } from 'pages/Affiliate/Affiliate.styled'

import { PartnerAffiliateSummary } from './PartnerAffiliateSummary'

import { type CreateState, useCreateAffiliateCode } from '../hooks/useCreateAffiliateCode'
import { affiliateAddressKey, isSolanaAffiliateAddress, referralShareLink } from '../lib/affiliateAddress'
import { type AffiliateStats, AffiliateApiError, getAffiliateStats } from '../lib/ophisAffiliateApi'
import { setAffiliateOwnCodeAtom } from '../state/affiliateOwnCodeAtom'

function formatUsd(value: number): string {
  if (!Number.isFinite(value)) return '$0'
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(value)
}

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
  const [loading, setLoading] = useState(true)
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
  solana: boolean
  activeCode?: string
  copy: (value: string) => void
  createState: CreateState
  isCopied: boolean
  onCreate: (payoutWallet?: string) => Promise<void>
}

function ReferralCodeSection({
  solana,
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
              { label: 'Share link', value: <InlineCode>{referralShareLink(activeCode, solana)}</InlineCode> },
            ]}
          />
          <ShareRow>
            <GhostButton type="button" onClick={() => copy(referralShareLink(activeCode, solana))}>
              {isCopied ? 'Copied' : 'Copy share link'}
            </GhostButton>
          </ShareRow>
        </>
      ) : (
        <CreateReferralCodeContent solana={solana} createState={createState} onCreate={onCreate} />
      )}
      <p>
        Share your referral link so new wallets can activate your code. View your referred wallet count and volume
        above.
      </p>
    </Section>
  )
}

function CreateReferralCodeContent({
  solana,
  createState,
  onCreate,
}: Pick<ReferralCodeSectionProps, 'createState' | 'onCreate' | 'solana'>): ReactNode {
  const [payout, setPayout] = useState('')
  const validPayout = /^0x[0-9a-f]{40}$/i.test(payout) && utils.isAddress(payout) && payout !== constants.AddressZero
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
      {solana && (
        <label>
          WETH payout address on Gnosis Chain
          <input
            type="text"
            autoComplete="off"
            spellCheck={false}
            value={payout}
            placeholder="0x…"
            onChange={(event) => setPayout(event.target.value.trim())}
          />
        </label>
      )}
      <ShareRow>
        <ActionButton
          type="button"
          onClick={() => void onCreate(solana ? payout.toLowerCase() : undefined)}
          disabled={isCreating || (solana && !validPayout)}
        >
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
  // The post-trade share link reuses the connected wallet's code.
  const persistOwnCode = useSetAtom(setAffiliateOwnCodeAtom)
  useEffect(() => {
    if (activeCode && stats && affiliateAddressKey(stats.wallet) === affiliateAddressKey(account))
      persistOwnCode({ account, code: activeCode })
  }, [account, activeCode, persistOwnCode, stats])

  if (!loading && !loadError && stats?.kind === 'partner') {
    return <PartnerAffiliateSummary stats={stats} />
  }

  return (
    <>
      <ReferralStatusSection loadError={loadError} loading={loading} stats={stats} />

      {!loading && !loadError && (
        <ReferralCodeSection
          solana={isSolanaAffiliateAddress(account)}
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
