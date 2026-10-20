/**
 * The connected partner's referral code, share link, and attribution totals.
 * The per-wallet API supplies these aggregates; the full referee breakdown
 * requires a signature on the Partner page.
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
      <Section id="referral" title="Referrals">
        <div style={{ marginBottom: 6 }}>
          <Badge tone="partner">Ophis Partner</Badge>
        </div>
        <MetricRow>
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
            Your partner code is being set up. It will appear here shortly. If it does not, reach out to your Ophis
            contact.
          </p>
        )}
        <p>
          Share your referral link so new wallets can activate your code. View your referred wallet count and volume
          above.
        </p>
        <p>
          <TextLink href={PARTNER_DASHBOARD_HREF}>View your full partner dashboard</TextLink> for the per-referee
          breakdown (signature required).
        </p>
      </Section>
    </>
  )
}
