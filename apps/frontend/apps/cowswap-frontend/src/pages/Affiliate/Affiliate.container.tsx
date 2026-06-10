/**
 * AffiliatePage — self-serve Ophis affiliate surface (Surface B).
 *
 * Wallet-aware. Calls the NATIVE rebate-indexer API directly
 * (rebates.ophis.fi via REACT_APP_REBATES_API) — no CoW BFF, no
 * LaunchDarkly. Shows the connected wallet's affiliate tier, rate, referred
 * count, and current-cycle referred volume; lets them mint a regular
 * referral code (signed) and copy a shareable ?ref link.
 *
 * AGENTS.md compliance: named export (no default), page implementation in
 * *.container.tsx, barrel re-export in index.ts, shared chrome in
 * Affiliate.styled.ts.
 */
import { ReactNode, useCallback, useEffect, useState } from 'react'

import { useCopyClipboard } from '@cowprotocol/common-hooks'
import { useWalletInfo } from '@cowprotocol/wallet'

import { Badge, Callout, InlineCode, KeyValueList, MetricCard, PageShell, Section, TextLink } from 'ophis/ds'

import {
  type AffiliateStats,
  AffiliateApiError,
  createRefCode,
  getAffiliateStats,
  useOphisAffiliateSign,
} from 'modules/affiliate'

import { ActionButton, GhostButton, MetricRow, ShareRow } from './Affiliate.styled'

const SHARE_ORIGIN = 'https://swap.ophis.fi'

function shareLink(code: string): string {
  return `${SHARE_ORIGIN}/?ref=${code}`
}

function formatUsd(value: number): string {
  if (!Number.isFinite(value)) return '$0'
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(value)
}

type CreateState = 'idle' | 'signing' | 'creating' | 'rejected' | 'error'

export function AffiliatePage(): ReactNode {
  const { account } = useWalletInfo()
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
    if (!account) {
      setStats(null)
      setLoadError(false)
      setLoading(false)
      return
    }
    const signal = { cancelled: false }
    loadStats(account, signal)
    return () => {
      signal.cancelled = true
    }
  }, [account, loadStats])

  const onCreate = useCallback(async () => {
    if (!account) return
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
  const kindLabel = stats?.kind === 'partner' ? 'Partner' : 'Regular'

  return (
    <PageShell
      width="medium"
      eyebrow="Affiliate"
      title="Share Ophis. Earn a share of the fee."
      lede="Mint a referral code, share your link, and earn a share of the fee Ophis keeps on every trade your referrals route. Paid monthly in WETH."
    >
      {!account ? (
        <Callout tone="info" title="Connect a wallet">
          <p>
            Use the <strong>Connect</strong> button in the header (top-right) to link a wallet.
            Your affiliate tier, referral code, and referred volume will appear here.
          </p>
        </Callout>
      ) : (
        <>
          <Section
            id="overview"
            title="Your program"
            intro={loadError ? undefined : `Tier and totals for ${account.slice(0, 6)}...${account.slice(-4)}.`}
          >
            {loading ? (
              <p>Loading your affiliate status...</p>
            ) : loadError ? (
              <Callout tone="warning" title="Could not load your status">
                <p>The affiliate service did not respond. Refresh the page to try again.</p>
              </Callout>
            ) : (
              <>
                <div style={{ marginBottom: 6 }}>
                  <Badge tone={stats?.kind === 'partner' ? 'partner' : 'live'}>{kindLabel}</Badge>
                </div>
                <MetricRow>
                  <MetricCard
                    label="Your rate"
                    value={`${stats?.rateOfNetFeePct ?? 8}%`}
                    sublabel="of the fee Ophis keeps"
                  />
                  <MetricCard label="Referred wallets" value={stats?.referredCount ?? 0} />
                  <MetricCard
                    label="Referred volume"
                    value={formatUsd(stats?.currentCycleVolumeUsd ?? 0)}
                    sublabel="this cycle"
                  />
                </MetricRow>
              </>
            )}
          </Section>

          {!loading && !loadError && (
            <Section id="code" title="Your referral code">
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
                          : 'Create your referral code'}
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
            </Section>
          )}

          <Section id="how" title="How it works">
            <p>
              Share your code or link. When a net-new wallet trades on Ophis after using your link,
              they&apos;re bound to you, and you earn a share of the fee Ophis keeps on their trades.
            </p>
            <p>Rewards are paid monthly in WETH. Aggregate totals only, no per-trade tracking is shown here.</p>
            {stats?.kind === 'partner' && (
              <p>
                You&apos;re an Ophis partner. See your full referee breakdown on the{' '}
                <TextLink href="/partner">partner dashboard</TextLink>.
              </p>
            )}
          </Section>
        </>
      )}
    </PageShell>
  )
}
