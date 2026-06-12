/**
 * Profile — wallet-aware trader identity page.
 *
 * Phase C restructure (2026-06-11): COMPACT "rank and profile" layout modeled
 * on Jumper's profile. Sections, in order:
 *   (a) identity   : truncated address / ENS / app chain (brief).
 *   (b) rank       : the rebate Tier (apps/rebate-indexer/src/tiers.ts) chip +
 *                    rebate % for the tier, fetched from /tier/:account.
 *   (c) referral   : the self-serve affiliate dashboard folded in (mint code,
 *                    share link, referred totals). REGULAR 8% tier only — no
 *                    partner-tier surface.
 *
 * The standalone /affiliate route now redirects here (RoutesApp.tsx); the
 * app-wide ?ref capture/bind updater is separate and untouched.
 *
 * AGENTS.md compliance:
 *   - Named export (no default).
 *   - Page implementation in *.container.tsx, not index.tsx.
 *   - Explorer URL built via getExplorerLink helper (respects
 *     REACT_APP_BLOCK_EXPLORER_URL override for local/custom explorers).
 *   - Rank card + actions extracted to sibling components to keep this file
 *     under the 250-LOC cap.
 */
import { ReactNode } from 'react'

import { CHAIN_INFO } from '@cowprotocol/common-const'
import { ExplorerDataType, getExplorerLink } from '@cowprotocol/common-utils'
import { useWalletDetails, useWalletInfo } from '@cowprotocol/wallet'

import { Callout, InlineCode, KeyValueList, PageShell, Section, TextLink } from 'ophis/ds'

import { OphisAffiliateDashboard } from 'modules/affiliate'
import { ConnectWalletCta } from 'pages/Affiliate/ConnectWalletCta'

import { ProfileActions } from './ProfileActions.pure'
import { ProfileRank } from './ProfileRank.container'

function truncateAddress(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

export function ProfilePage(): ReactNode {
  const { account, chainId } = useWalletInfo()
  const { ensName, walletName } = useWalletDetails()
  const chain = chainId in CHAIN_INFO ? CHAIN_INFO[chainId as keyof typeof CHAIN_INFO] : undefined
  const explorerUrl = account ? getExplorerLink(chainId, account, ExplorerDataType.ADDRESS) : undefined

  return (
    <PageShell
      width="medium"
      eyebrow="Profile"
      title="Your rank, rebates, and referrals."
      lede="Connect a wallet to see your tier rank, rebate rate, and referral code. Read from your wallet and the public rebate indexer."
    >
      <Section id="identity" title="Identity">
        {account ? (
          <KeyValueList
            items={[
              { label: 'Address', value: <InlineCode>{truncateAddress(account)}</InlineCode> },
              {
                label: 'ENS',
                value: ensName ? <InlineCode>{ensName}</InlineCode> : <em>none</em>,
              },
              {
                label: 'App chain',
                value: chain ? `${chain.label} (#${chainId})` : `Chain #${chainId}`,
              },
              { label: 'Wallet', value: walletName ?? <em>unknown provider</em> },
              {
                label: 'Explorer',
                value: explorerUrl ? (
                  <TextLink href={explorerUrl} external>
                    View on {chain?.explorerTitle ?? 'explorer'}
                  </TextLink>
                ) : (
                  'Not available'
                ),
              },
            ]}
          />
        ) : (
          <Callout tone="info" title="Connect a wallet">
            <p>
              Connect a wallet to see your address, rank, and referral code. Identity is read from
              the wallet, not stored by Ophis.
            </p>
            <ConnectWalletCta />
          </Callout>
        )}
      </Section>

      {account && <ProfileRank account={account} />}

      {account && <OphisAffiliateDashboard account={account} />}

      <Section id="actions" title="What you can do today">
        <ProfileActions />
      </Section>
    </PageShell>
  )
}
