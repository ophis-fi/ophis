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
 * PARTNER-AWARE: when GET /affiliate/:wallet reports `kind === 'partner'` for
 * the connected wallet, this renders the read-only PartnerAffiliateSummary
 * (status, rate, assigned code + share link, referred totals, link to the
 * signature-gated /#/partner breakdown) INSTEAD of the regular mint-a-code
 * flow. Partners already have a code, so the mint action is never offered to
 * them. Everything below the partner branch is the REGULAR 8% self-serve tier
 * only; the friends-and-family tier is NOT surfaced here.
 *
 * AGENTS.md compliance: named export (no default), shared chrome reused from
 * the Affiliate page's styled module.
 */
import { ReactNode, useCallback, useEffect, useRef, useState } from 'react'

import { useCopyClipboard } from '@cowprotocol/common-hooks'
import { areAddressesEqual } from '@cowprotocol/cow-sdk'

import { Callout, InlineCode, KeyValueList, MetricCard, Section } from 'ophis/ds'

import { ActionButton, GhostButton, MetricRow, ShareRow } from 'pages/Affiliate/Affiliate.styled'

import { useOphisAffiliateSign } from '../hooks/useOphisAffiliateSign'
import { type AffiliateStats, AffiliateApiError, createRefCode, getAffiliateStats } from '../lib/ophisAffiliateApi'

import { PartnerAffiliateSummary } from './PartnerAffiliateSummary'

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

  // Latest connected account, for guarding async continuations: a wallet
  // switch mid-sign/mid-request must not render the OLD wallet's minted code
  // under the NEW wallet's dashboard.
  const accountRef = useRef(account)
  accountRef.current = account

  // A GENUINE wallet switch resets the mint state machine (a stale in-flight
  // create or error/rejected state would otherwise mislabel the new wallet's
  // button). Key on the lowercased address so a checksum-only re-emit of the
  // SAME wallet does NOT reset mid-signature -- otherwise the reset re-enables
  // the button and the user can fire a duplicate createRefCode (Codex review).
  const accountKey = account.toLowerCase()
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
              rateOfNetFeePct: 8,
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
  }, [account, sign])

  const activeCode = stats?.activeCodes?.[0]
  // Render the rate from the backend (8 is only a last-resort fallback before
  // stats load), so the view tracks FEE_SHARE_BPS if the policy ever changes.
  const rate = stats?.rateOfNetFeePct ?? 8

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
              Earn {rate}% of the fee Ophis keeps on every trade your referrals route. Paid monthly in WETH.
            </p>
            <MetricRow>
              <MetricCard label="Your rate" value={`${rate}%`} sublabel="of the fee Ophis keeps" compact />
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
