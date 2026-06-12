import { ReactNode } from 'react'

import { useCopyClipboard } from '@cowprotocol/common-hooks'

import { InlineCode, KeyValueList } from 'ophis/ds'

import { GhostButton, ShareRow } from '../Affiliate/Affiliate.styled'

// The swap app reads ?ref=<code> on load and binds the visitor to the referrer,
// so the shareable link is always swap.ophis.fi regardless of which surface
// renders it (the same origin the Profile PartnerAffiliateSummary uses).
const SHARE_ORIGIN = 'https://swap.ophis.fi'

function shareLink(code: string): string {
  return `${SHARE_ORIGIN}/?ref=${code}`
}

function shareOnXUrl(code: string): string {
  const text = `Swap on Ophis: intent-based, MEV-protected, gasless. ${shareLink(code)}`
  return `https://x.com/intent/post?text=${encodeURIComponent(text)}`
}

/**
 * The partner's referral code + shareable link + copy and share-on-X actions.
 * activeCodes[0] is already in the POST /partner payload but was never rendered
 * on the Partner dashboard, so a partner could not get their link from this
 * page. Mirrors the share block on the Profile PartnerAffiliateSummary.
 */
export function PartnerReferralShare({ code }: { code: string | undefined }): ReactNode {
  const [isCopied, copy] = useCopyClipboard()

  if (!code) {
    return (
      <p>
        Your partner code is being set up. It will appear here shortly. If it does not, reach out to
        your Ophis contact.
      </p>
    )
  }

  const link = shareLink(code)

  return (
    <>
      <KeyValueList
        items={[
          { label: 'Code', value: <InlineCode>{code}</InlineCode> },
          { label: 'Share link', value: <InlineCode>{link}</InlineCode> },
        ]}
      />
      <ShareRow>
        <GhostButton type="button" onClick={() => copy(link)}>
          {isCopied ? 'Copied' : 'Copy share link'}
        </GhostButton>
        <GhostButton
          type="button"
          onClick={() => window.open(shareOnXUrl(code), '_blank', 'noopener,noreferrer')}
        >
          Share on X
        </GhostButton>
      </ShareRow>
    </>
  )
}

/**
 * Richer empty state for the Referees section. A 0-referee partner is the
 * default viewer, so instead of one bare line we show a 3-step how-it-works that
 * tells them exactly what to do and fills the space. The rate is read from the
 * API so the copy never drifts from FEE_SHARE_BPS.
 */
export function PartnerEmptyReferees({ rate }: { rate: number }): ReactNode {
  return (
    <>
      <p>No referees yet. Here is how the program works:</p>
      <ol>
        <li>Share your code or link above.</li>
        <li>A net-new wallet trades on Ophis after using it, and is bound to you for life.</li>
        <li>You earn {rate}% of the net fee Ophis keeps on their trades, paid monthly in WETH.</li>
      </ol>
      <p style={{ opacity: 0.75 }}>Your referees will appear here once a wallet binds to your code.</p>
    </>
  )
}
