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
        Your partner code is being set up. It will appear here shortly. If it does not, reach out to your Ophis contact.
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
        <GhostButton type="button" onClick={() => window.open(shareOnXUrl(code), '_blank', 'noopener,noreferrer')}>
          Share on X
        </GhostButton>
      </ShareRow>
    </>
  )
}

/** Attribution steps for partners with no referred wallets yet. */
export function PartnerEmptyReferees(): ReactNode {
  return (
    <>
      <h3>How the program works</h3>
      <p>No referees yet.</p>
      <ol>
        <li>Share your code or link above.</li>
        <li>New wallets can activate your code through your link. A code tagged on an order attributes that trade.</li>
        <li>Track referred wallets and volume in your dashboard.</li>
      </ol>
      <p style={{ opacity: 0.75 }}>
        Wallets appear here after binding your link or settling an eligible trade tagged with your code.
      </p>
    </>
  )
}
