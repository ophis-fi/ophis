/**
 * Wallet identity and referral attribution. The /affiliate route redirects here;
 * app-wide referral activation is handled by RefCodeCaptureUpdater.
 */
import { ReactNode } from 'react'

import { CHAIN_INFO } from '@cowprotocol/common-const'
import { ExplorerDataType, getExplorerLink } from '@cowprotocol/common-utils'
import { useWalletDetails, useWalletInfo } from '@cowprotocol/wallet'

import { Callout, InlineCode, KeyValueList, PageShell, Section, TextLink } from 'ophis/ds'

import { OphisAffiliateDashboard, useAffiliateWallet, affiliateAddressKey } from 'modules/affiliate'

import { AffiliateNetworkPicker, ConnectWalletCta } from 'pages/Affiliate/ConnectWalletCta'

import { ProfileActions } from './ProfileActions.pure'

function truncateAddress(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

export function ProfilePage(): ReactNode {
  const { chainId } = useWalletInfo()
  const { account, isSolana, solana, enabled, needsMessageSigning } = useAffiliateWallet()
  const { ensName, walletName } = useWalletDetails()
  const chain = chainId in CHAIN_INFO ? CHAIN_INFO[chainId as keyof typeof CHAIN_INFO] : undefined
  const explorerUrl = account
    ? isSolana
      ? `https://explorer.solana.com/address/${account}`
      : getExplorerLink(chainId, account, ExplorerDataType.ADDRESS)
    : undefined

  return (
    <PageShell
      width="medium"
      eyebrow="Profile"
      title="Your wallet and referrals."
      lede={
        account
          ? 'Your wallet identity and referral activity in one place.'
          : 'Connect a wallet to see your referral code and activity.'
      }
    >
      {enabled && <AffiliateNetworkPicker solana={isSolana} needsMessageSigning={needsMessageSigning} />}
      <Section id="identity" title="Identity">
        {account ? (
          <KeyValueList
            items={[
              { label: 'Address', value: <InlineCode>{truncateAddress(account)}</InlineCode> },
              ...(!isSolana
                ? [
                    {
                      label: 'ENS',
                      value: ensName ? (
                        <InlineCode>{ensName}</InlineCode>
                      ) : (
                        <span aria-label="ENS name unavailable">-</span>
                      ),
                    },
                  ]
                : []),
              {
                label: 'App chain',
                value: isSolana ? 'Solana mainnet' : chain ? `${chain.label} (#${chainId})` : `Chain #${chainId}`,
              },
              { label: 'Wallet', value: (isSolana ? solana?.wallet.name : walletName) ?? <em>unknown provider</em> },
              {
                label: 'Explorer',
                value: explorerUrl ? (
                  <TextLink href={explorerUrl} external>
                    View on {isSolana ? 'Solana Explorer' : (chain?.explorerTitle ?? 'explorer')}
                  </TextLink>
                ) : (
                  'Not available'
                ),
              },
            ]}
          />
        ) : (
          <Callout tone="info" title="Connect a wallet">
            <p>Connect a wallet to see your address and referral code.</p>
            <ConnectWalletCta solana={isSolana} />
          </Callout>
        )}
      </Section>

      {account && <OphisAffiliateDashboard key={affiliateAddressKey(account)} account={account} />}

      <Section id="actions" title="What you can do today">
        <ProfileActions />
      </Section>
    </PageShell>
  )
}
