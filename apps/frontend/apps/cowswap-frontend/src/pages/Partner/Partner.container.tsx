/**
 * PartnerPage — Ophis partner dashboard (Surface C). WHITELIST + SIGNATURE
 * gated.
 *
 * Partner data MUST NOT render to the general public. ALL partner data
 * (stats + referee table) is gated behind a successful signed
 * POST /partner against the NATIVE rebate-indexer API (rebates.ophis.fi).
 * Nothing partner-specific is fetched or shown until that POST returns 200.
 *
 *   - 403 -> "for Ophis partners only" (no data).
 *   - 401 -> expired / retry message.
 *
 * AGENTS.md compliance: named export (no default), page implementation in
 * *.container.tsx, barrel re-export in index.ts. Shared chrome reused from
 * the Affiliate page's styled module.
 */
import { ReactNode, useCallback, useState } from 'react'

import { useWalletInfo } from '@cowprotocol/wallet'

import {
  Badge,
  Callout,
  InlineCode,
  MetricCard,
  PageShell,
  Section,
  Table,
  Tbody,
  Td,
  Th,
  Thead,
  Tr,
} from 'ophis/ds'

import { type PartnerDashboard, AffiliateApiError, getPartnerDashboard, useOphisAffiliateSign } from 'modules/affiliate'

import { ActionButton, MetricRow } from '../Affiliate/Affiliate.styled'

function truncate(addr: string): string {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`
}

function formatUsd(value: number): string {
  if (!Number.isFinite(value)) return '$0'
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(value)
}

function formatDate(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '-' : d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
}

type AccessState = 'idle' | 'signing' | 'loading' | 'forbidden' | 'unauthorized' | 'rejected' | 'error' | 'network'

export function PartnerPage(): ReactNode {
  const { account } = useWalletInfo()
  const sign = useOphisAffiliateSign(account)

  const [data, setData] = useState<PartnerDashboard | null>(null)
  const [state, setState] = useState<AccessState>('idle')

  const onAccess = useCallback(async () => {
    if (!account) return
    setState('signing')
    setData(null)
    try {
      const body = await sign('Partner Dashboard access')
      setState('loading')
      const dashboard = await getPartnerDashboard(body)
      setData(dashboard)
      setState('idle')
    } catch (error: unknown) {
      const code = (error as { code?: number | string })?.code
      if (code === 4001 || code === 'ACTION_REJECTED') {
        setState('rejected')
        return
      }
      if (error instanceof AffiliateApiError) {
        if (error.status === 403) {
          setState('forbidden')
          return
        }
        if (error.status === 401) {
          setState('unauthorized')
          return
        }
        // 400 / 409 / 429 / 5xx: a real server response. Keep the generic state
        // but log the status + server message so it is diagnosable.
        console.error('[PartnerPage] access failed:', error.status, error.message)
        setState('error')
        return
      }
      // Not an API response at all: a CORS/network failure (TypeError "Failed to
      // fetch") or a request timeout (DOMException). Surface a distinct message so
      // a transport break is not mistaken for a server error (this is the class of
      // failure the CORS-preflight bug produced).
      console.error('[PartnerPage] access failed (network/transport):', error)
      setState('network')
    }
  }, [account, sign])

  const busy = state === 'signing' || state === 'loading'

  return (
    <PageShell
      width="wide"
      eyebrow="Partner"
      title="Partner dashboard."
      lede="Your referee breakdown, rate, and referred volume. Access is restricted to Ophis partners and requires a wallet signature."
    >
      {!account ? (
        <Callout tone="info" title="Connect a wallet">
          <p>
            Use the <strong>Connect</strong> button in the header (top-right) to link your partner
            wallet, then sign in below to load your dashboard.
          </p>
        </Callout>
      ) : !data ? (
        <Section id="access" title="Access your dashboard">
          <p>
            Partner data is private. Sign a message with your partner wallet to load your stats and
            referee breakdown. This is a signature only, no transaction and no gas.
          </p>
          <ActionButton type="button" onClick={onAccess} disabled={busy}>
            {state === 'signing'
              ? 'Confirm in your wallet...'
              : state === 'loading'
                ? 'Loading...'
                : 'Access Partner Dashboard'}
          </ActionButton>
          {state === 'forbidden' && (
            <Callout tone="warning" title="Partners only">
              <p>This dashboard is for Ophis partners only.</p>
            </Callout>
          )}
          {state === 'unauthorized' && (
            <Callout tone="warning" title="Signature expired">
              <p>Your signature could not be verified or has expired. Please try again.</p>
            </Callout>
          )}
          {state === 'rejected' && (
            <Callout tone="warning" title="Signature cancelled">
              <p>You declined the signature. Click the button again when you&apos;re ready.</p>
            </Callout>
          )}
          {state === 'error' && (
            <Callout tone="warning" title="Could not load the dashboard">
              <p>Something went wrong. Please try again in a moment.</p>
            </Callout>
          )}
          {state === 'network' && (
            <Callout tone="warning" title="Could not reach the partner service">
              <p>
                A network or connection issue blocked the request. Check your connection and try
                again in a moment.
              </p>
            </Callout>
          )}
        </Section>
      ) : (
        <>
          <Section id="overview" title="Your program">
            <div style={{ marginBottom: 6 }}>
              <Badge tone="partner">Partner</Badge>
            </div>
            <MetricRow>
              <MetricCard label="Your rate" value={`${data.rateOfNetFeePct}%`} sublabel="of the fee Ophis keeps" />
              <MetricCard label="Referred wallets" value={data.referredCount} />
              <MetricCard
                label="Referred volume"
                value={formatUsd(data.lifetimeReferredVolumeUsd)}
                sublabel="lifetime"
              />
            </MetricRow>
          </Section>

          <Section id="referees" title="Referees">
            {data.referees.length === 0 ? (
              <p>No referees yet. Share your code to start referring wallets.</p>
            ) : (
              <>
                <Table caption="Your referred wallets, bind date, and lifetime referred volume.">
                  <Thead>
                    <Tr>
                      <Th>Wallet</Th>
                      <Th>Bound</Th>
                      <Th>Lifetime volume</Th>
                    </Tr>
                  </Thead>
                  <Tbody>
                    {data.referees.map((referee) => (
                      <Tr key={referee.wallet}>
                        <Td>
                          <InlineCode>{truncate(referee.wallet)}</InlineCode>
                        </Td>
                        <Td>{formatDate(referee.boundAt)}</Td>
                        <Td>{formatUsd(referee.lifetimeVolumeUsd)}</Td>
                      </Tr>
                    ))}
                  </Tbody>
                </Table>
                {/* The /partner referees query is capped (ORDER BY bound_at DESC LIMIT N),
                    so a partner with more referees than the cap sees a truncated table.
                    referredCount is the un-capped total; the shown count is read from the
                    array length so this note never hardcodes (or drifts from) the backend
                    LIMIT. */}
                {data.referredCount > data.referees.length && (
                  <p style={{ marginTop: 8, opacity: 0.75, fontSize: '0.9em' }}>
                    Showing the {data.referees.length} most recently bound of {data.referredCount}{' '}
                    referees. Reach out to your Ophis contact for a full export.
                  </p>
                )}
              </>
            )}
          </Section>
        </>
      )}
    </PageShell>
  )
}
