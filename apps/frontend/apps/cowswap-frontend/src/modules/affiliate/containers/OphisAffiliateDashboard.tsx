/**
 * OphisAffiliateDashboard — the self-serve affiliate dashboard body, extracted
 * from the standalone /affiliate page so it can be folded into the Profile
 * page (Phase C restructure, 2026-06-11).
 *
 * Wallet-aware. Calls the NATIVE rebate-indexer API directly
 * (rebates.ophis.fi via REACT_APP_REBATES_API) — no CoW BFF, no LaunchDarkly.
 * Shows the connected wallet's affiliate rate, referred count, and
 * current-cycle referred volume; lets them mint a regular referral code
 * (signed) and copy a shareable ?ref link.
 *
 * PUBLIC affiliate program = the REGULAR 8% tier only. The partner /
 * friends-and-family tier is NOT surfaced here.
 *
 * AGENTS.md compliance: named export (no default), shared chrome reused from
 * the Affiliate page's styled module.
 */
import { ReactNode, useCallback, useEffect, useState } from 'react'

import { useCopyClipboard } from '@cowprotocol/common-hooks'

import { Callout, InlineCode, KeyValueList, MetricCard, Section } from 'ophis/ds'

import { ActionButton, GhostButton, MetricRow, ShareRow } from 'pages/Affiliate/Affiliate.styled'

import { useOphisAffiliateSign } from '../hooks/useOphisAffiliateSign'
import { type AffiliateStats, AffiliateApiError, createRefCode, getAffiliateStats } from '../lib/ophisAffiliateApi'

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

export function OphisAffiliateDashboard({ account }: Props): ReactNode {
  const sign = useOphisAffiliateSign(account)
  const [isCopied, copy] = useCopyClipboard()

  const [stats, setStats] = useState<AffiliateStats | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState(false)
  const [createState, setCreateState] = useState<CreateState>('idle')

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

  const onCreate = useCallback(async () => {
    setCreateState('signing')
    try {
      const body = await sign('create referral code')
      setCreateState('creating')
      const res = await createRefCode(body)
      setStats((prev) =>
        prev
          ? { ...prev, activeCodes: [res.code, ...prev.activeCodes.filter((c) => c !== res.code)] }
          : {
              wallet: account,
              kind: 'regular',
              rateOfNetFeePct: 8,
              activeCodes: [res.code],
              referredCount: 0,
              currentCycleVolumeUsd: 0,
            },
      )
      setCreateState('idle')
    } catch (error: unknown) {
      // User-rejected signature (ethers v5 ACTION_REJECTED / EIP-1193 4001).
      const code = (error as { code?: number | string })?.code
      if (code === 4001 || code === 'ACTION_REJECTED') {
        setCreateState('rejected')
      } else {
        setCreateState('error')
      }
    }
  }, [account, sign])

  const activeCode = stats?.activeCodes?.[0]

  return (
    <>
      <Section id="referral" title="Refer and earn">
        {loading ? (
          <p>Loading your referral status...</p>
        ) : loadError ? (
          <Callout tone="warning" title="Could not load your status">
            <p>The affiliate service did not respond. Refresh the page to try again.</p>
          </Callout>
        ) : (
          <>
            <p>
              Earn 8% of the fee Ophis keeps on every trade your referrals route. Paid monthly in WETH.
            </p>
            <MetricRow>
              <MetricCard label="Your rate" value="8%" sublabel="of the fee Ophis keeps" compact />
              <MetricCard label="Referred wallets" value={stats?.referredCount ?? 0} compact />
              <MetricCard
                label="Referred volume"
                value={formatUsd(stats?.currentCycleVolumeUsd ?? 0)}
                sublabel="this cycle"
                compact
              />
            </MetricRow>
          </>
        )}
      </Section>

      {!loading && !loadError && (
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
            <>
              <p>
                You don&apos;t have an active code yet. Create one, it takes a single wallet
                signature (no transaction, no gas).
              </p>
              <ShareRow>
                <ActionButton
                  type="button"
                  onClick={onCreate}
                  disabled={createState === 'signing' || createState === 'creating'}
                >
                  {createState === 'signing'
                    ? 'Confirm in your wallet...'
                    : createState === 'creating'
                      ? 'Creating...'
                      : 'Mint your referral code'}
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
          )}
          <p>
            Share your code or link. When a net-new wallet trades on Ophis after using your link,
            they&apos;re bound to you, and you earn a share of the fee Ophis keeps on their trades.
            Aggregate totals only, no per-trade tracking is shown here.
          </p>
        </Section>
      )}
    </>
  )
}
