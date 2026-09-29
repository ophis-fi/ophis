/**
 * PartnerPage — Ophis partner dashboard. All partner data is whitelist- and
 * signature-gated by POST /partner on rebates.ophis.fi, never fetched or shown
 * before a successful response. Wallet-keyed sessions reset access on disconnect
 * or an identity change, including when the previous response is still pending.
 *
 *   - 403 -> "for Ophis partners only" (no data).
 *   - 401 -> expired / retry message.
 *
 */
import { ReactNode, useCallback, useState } from 'react'

import { getAddressKey } from '@cowprotocol/cow-sdk'
import { useWalletInfo } from '@cowprotocol/wallet'

import { Badge, Callout, InlineCode, MetricCard, PageShell, Section, Table, Tbody, Td, Th, Thead, Tr } from 'ophis/ds'

import { type PartnerDashboard, AffiliateApiError, getPartnerDashboard, useOphisAffiliateSign } from 'modules/affiliate'

import { ConnectWalletCta } from 'pages/Affiliate/ConnectWalletCta'

import { formatUsd } from './Partner.utils'
import { PartnerEarnings, PartnerTraderRank, ReferredVolumeMetric } from './PartnerDashboardCards'
import { PartnerEmptyReferees, PartnerReferralShare } from './PartnerReferralShare'

import { ActionButton, MetricRow } from '../Affiliate/Affiliate.styled'

function truncate(addr: string): string {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`
}

function formatDate(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime())
    ? '-'
    : d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
}

type AccessState = 'idle' | 'signing' | 'loading' | 'forbidden' | 'unauthorized' | 'rejected' | 'error' | 'network'

interface PartnerAccessProps {
  busy: boolean
  onAccess: () => Promise<void>
  state: AccessState
}

function PartnerAccess({ busy, onAccess, state }: PartnerAccessProps): ReactNode {
  const buttonLabel =
    state === 'signing' ? 'Confirm in your wallet...' : state === 'loading' ? 'Loading...' : 'Access Partner Dashboard'

  return (
    <Section id="access" title="Access your dashboard">
      <p>
        Partner data is private. Sign a message with your partner wallet to load your stats and referee breakdown. This
        does not submit a swap or approve token spending. Contract wallets require an Ophis-approved authentication
        chain and may need additional Safe approvals.
      </p>
      <ActionButton type="button" onClick={onAccess} disabled={busy}>
        {buttonLabel}
      </ActionButton>
      {state === 'forbidden' && (
        <Callout tone="warning" title="Partners only">
          <p>This dashboard is for Ophis partners only.</p>
        </Callout>
      )}
      {state === 'unauthorized' && (
        <Callout tone="warning" title="Signature not verified">
          <p>
            Your signature could not be verified or has expired. For a contract wallet, use its Ophis-approved
            authentication chain; contact Ophis if that chain has not been configured.
          </p>
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
          <p>A network or connection issue blocked the request. Check your connection and try again in a moment.</p>
        </Callout>
      )}
    </Section>
  )
}

interface PartnerDashboardContentProps {
  account: string
  data: PartnerDashboard
}

function PartnerDashboardContent({ account, data }: PartnerDashboardContentProps): ReactNode {
  const hasHiddenReferees = data.referredCount > data.referees.length

  return (
    <>
      <Section id="overview" title="Your program">
        <div style={{ marginBottom: 6 }}>
          <Badge tone="partner">Partner</Badge>
        </div>
        <MetricRow>
          <MetricCard label="Your rate" value={`${data.rateOfNetFeePct}%`} sublabel="of the verified base fee" />
          <MetricCard label="Referred wallets" value={data.referredCount} />
          <ReferredVolumeMetric lifetimeUsd={data.lifetimeReferredVolumeUsd} cycleUsd={data.currentCycleVolumeUsd} />
        </MetricRow>
        <div style={{ marginTop: 12 }}>
          <PartnerTraderRank account={account} />
        </div>
      </Section>

      <PartnerEarnings
        estimatedCurrentCycleEarningsUsd={data.estimatedCurrentCycleEarningsUsd}
        paidToDateWeth={data.paidToDateWeth}
        paidToDateUsd={data.paidToDateUsd}
        nextPayoutAt={data.nextPayoutAt}
        payoutStatus={data.payoutStatus}
      />

      <Section id="link" title="Your referral link">
        <p>
          Share your link or tag eligible orders with your code. Link binding and per-order code attribution are
          different paths; an order tag does not permanently bind a wallet. Your rate is {data.rateOfNetFeePct}% of the
          verified base fee Ophis keeps on eligible attributed trades.
        </p>
        <PartnerReferralShare code={data.activeCodes[0]} />
      </Section>

      <Section id="referees" title="Referees">
        {data.referees.length === 0 ? (
          <PartnerEmptyReferees rate={data.rateOfNetFeePct} />
        ) : (
          <>
            <Table caption="Your referred wallets, first referral date, attribution, and lifetime referred volume.">
              <Thead>
                <Tr>
                  <Th>Wallet</Th>
                  <Th>First referred</Th>
                  <Th>Attribution</Th>
                  <Th>Lifetime volume</Th>
                </Tr>
              </Thead>
              <Tbody>
                {data.referees.map((referee) => (
                  <Tr key={referee.wallet}>
                    <Td>
                      <InlineCode>{truncate(referee.wallet)}</InlineCode>
                    </Td>
                    <Td>{formatDate(referee.firstSeenAt ?? referee.boundAt ?? '')}</Td>
                    <Td>
                      {referee.attribution === 'code'
                        ? 'Code'
                        : referee.attribution === 'link-and-code'
                          ? 'Link + code'
                          : 'Link'}
                    </Td>
                    <Td>{formatUsd(referee.lifetimeVolumeUsd)}</Td>
                  </Tr>
                ))}
              </Tbody>
            </Table>
            {hasHiddenReferees && (
              <p style={{ marginTop: 8, opacity: 0.75, fontSize: '0.9em' }}>
                Showing the {data.referees.length} most recently referred of {data.referredCount} referees. Reach out to
                your Ophis contact for a full export.
              </p>
            )}
          </>
        )}
      </Section>
    </>
  )
}

function PartnerWalletDashboard({ account }: { account: string }): ReactNode {
  const sign = useOphisAffiliateSign(account)

  const [data, setData] = useState<PartnerDashboard | null>(null)
  const [state, setState] = useState<AccessState>('idle')

  const onAccess = useCallback(async () => {
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
  }, [sign])

  const busy = state === 'signing' || state === 'loading'

  return data ? (
    <PartnerDashboardContent account={account} data={data} />
  ) : (
    <PartnerAccess busy={busy} onAccess={onAccess} state={state} />
  )
}

export function PartnerPage(): ReactNode {
  const { account } = useWalletInfo()

  return (
    <PageShell
      width="wide"
      eyebrow="Partner"
      title="Partner dashboard."
      lede="Your referee breakdown, rate, and referred volume. Access is restricted to Ophis partners and requires a wallet signature."
    >
      {!account ? (
        <Callout tone="info" title="Connect a wallet">
          <p>Connect your partner wallet, then sign in below to load your dashboard.</p>
          <ConnectWalletCta>Connect Partner Wallet</ConnectWalletCta>
        </Callout>
      ) : (
        <PartnerWalletDashboard key={getAddressKey(account)} account={account} />
      )}
    </PageShell>
  )
}
