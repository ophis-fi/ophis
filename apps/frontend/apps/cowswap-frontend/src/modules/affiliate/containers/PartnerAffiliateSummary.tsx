/**
 * PartnerAffiliateSummary — the PARTNER-aware variant of the Profile affiliate
 * section. Rendered (instead of the regular self-serve "mint a code" flow) when
 * the connected wallet's PUBLIC GET /affiliate/:wallet payload reports
 * `kind === 'partner'`.
 *
 * Partners already have an assigned code, so this view NEVER offers the
 * mint-code action. It shows their partner status, rate, active code +
 * shareable link (copy), referred count / current-cycle referred volume, and a
 * link to the full signature-gated referee breakdown at /#/partner.
 *
 * Data shown here is the connected wallet's OWN aggregate data from the public
 * per-wallet endpoint. No other partner's data, no payout wallet, and no
 * friends-and-family tier is surfaced. The full referee breakdown stays behind
 * the signature gate on the Partner page.
 *
 * AGENTS.md compliance: named export (no default), shared chrome reused from
 * the Affiliate page's styled module + ophis/ds primitives.
 */
import { ReactNode } from 'react'

import { useCopyClipboard } from '@cowprotocol/common-hooks'

import { Badge, InlineCode, KeyValueList, MetricCard, Section, TextLink } from 'ophis/ds'

import { GhostButton, MetricRow, ShareRow } from 'pages/Affiliate/Affiliate.styled'

import type { AffiliateStats } from '../lib/ophisAffiliateApi'

const SHARE_ORIGIN = 'https://swap.ophis.fi'

// HashRouter SPA: the signature-gated partner dashboard lives at /#/partner.
const PARTNER_DASHBOARD_HREF = '/#/partner'

function shareLink(code: string): string {
  return `${SHARE_ORIGIN}/?ref=${code}`
}

function formatUsd(value: number): string {
  if (!Number.isFinite(value)) return '$0'
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(value)
}

interface Props {
  stats: AffiliateStats
}

export function PartnerAffiliateSummary({ stats }: Props): ReactNode {
  const [isCopied, copy] = useCopyClipboard()

  const activeCode = stats.activeCodes?.[0]

  return (
    <>
      <Section id="referral" title="Refer and earn">
        <div style={{ marginBottom: 6 }}>
          <Badge tone="partner">Ophis Partner</Badge>
        </div>
        <p>
          Earn {stats.rateOfNetFeePct}% of the fee Ophis keeps on every trade your referrals route.
          Paid monthly in WETH.
        </p>
        <MetricRow>
          <MetricCard
            label="Your rate"
            value={`${stats.rateOfNetFeePct}%`}
            sublabel="of the fee Ophis keeps"
            compact
          />
          <MetricCard label="Referred wallets" value={stats.referredCount ?? 0} compact />
          <MetricCard
            label="Referred volume"
            value={formatUsd(stats.lifetimeReferredVolumeUsd ?? 0)}
            sublabel="lifetime"
            compact
          />
        </MetricRow>
      </Section>

      <Section id="referral-code" title="Your partner code">
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
          <p>
            Your partner code is being set up. It will appear here shortly. If it does not, reach out
            to your Ophis contact.
          </p>
        )}
        <p>
          Share your code or link. When a net-new wallet trades on Ophis after using your link,
          they&apos;re bound to you, and you earn a share of the fee Ophis keeps on their trades.
        </p>
        <p>
          <TextLink href={PARTNER_DASHBOARD_HREF}>View your full partner dashboard</TextLink> for the
          per-referee breakdown (signature required).
        </p>
      </Section>
    </>
  )
}
