/**
 * Profile — wallet-aware trader identity page (Phase C1, 2026-05-23).
 *
 * Modeled on Jumper's Loyalty Pass IA but deliberately stripped of any
 * gamification language that implies a backend that does not exist yet.
 * Reviewed by Codex pre-merge (2026-05-23):
 *   - No fabricated XP / Level / Rank — those imply live scoring.
 *   - No "Current tier" — that implies eligibility was computed; we
 *     show "Default framework tier" while the volume indexer is offline.
 *   - No placeholder partner cards — they look like inventory. A single
 *     Callout(planned) replaces them.
 *   - Identity surfaces ONLY what's verifiable from the wallet itself
 *     (address, chain, optional ENS, optional wallet name). No inferred
 *     activity, no leaderboard.
 *
 * Real backend (volume indexer, tier auto-progression, partner perks) is
 * targeted for Q3 2026.
 *
 * AGENTS.md compliance (post-Codex GitHub bot audit):
 *   - Named export (no default).
 *   - Page implementation in *.container.tsx, not index.tsx.
 *   - Explorer URL built via getExplorerLink helper (respects
 *     REACT_APP_BLOCK_EXPLORER_URL override for local Otterscan / custom
 *     explorer deployments).
 *   - Wallet support copy genericized (no hardcoded enumeration that can
 *     drift from the real connector set).
 *   - "What you can do today" grid extracted to ProfileActions.pure.tsx
 *     to keep this file under the 250-LOC cap.
 */
import { ReactNode } from 'react'

import { CHAIN_INFO } from '@cowprotocol/common-const'
import { ExplorerDataType, getExplorerLink } from '@cowprotocol/common-utils'
import { useWalletDetails, useWalletInfo } from '@cowprotocol/wallet'

import { Callout, InlineCode, KeyValueList, PageShell, Section, TextLink } from 'ophis/ds'

import { ProfileActions } from './ProfileActions.pure'

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
      title="Wallet-aware identity. Honest about what's live."
      lede="Connect a wallet to see your address, current app chain, and ENS name, read directly from your wallet. Ophis holds no account and stores nothing on this page."
    >
      <Callout tone="info" title="Data sources">
        <p>
          <strong>Read locally from your wallet:</strong> address, current app chain, wallet
          provider name. Nothing is sent to Ophis servers for this section to render.{' '}
          <strong>Resolved via public RPC:</strong> ENS name (if any) is looked up against the
          public ENS registry.
        </p>
      </Callout>

      <Section id="identity" title="Identity">
        {account ? (
          <>
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
                      View address on {chain?.explorerTitle ?? 'explorer'}
                    </TextLink>
                  ) : (
                    'Not available'
                  ),
                },
              ]}
            />
            <Callout tone="info">
              <p>
                <strong>Note on the chain row.</strong> &quot;App chain&quot; is the chain Ophis
                is routing on for this session, normalized to a supported network. Your wallet
                may report a different current chain — check your wallet UI for the actual
                network it holds. The explorer link points to the app-chain block explorer.
              </p>
            </Callout>
          </>
        ) : (
          <Callout tone="info" title="Connect a wallet">
            <p>
              Use the <strong>Connect</strong> button in the header (top-right) to link a wallet.
              Your address and current app chain will appear here. Nothing else is collected —
              identity is read from the wallet, not stored by Ophis.
            </p>
            <p>
              Ophis uses the upstream CoW Swap wallet stack and supports the wallets exposed by
              the configured connectors. The full list is governed by upstream — there is no
              custody and no Ophis-specific wallet allowlist.
            </p>
          </Callout>
        )}
      </Section>

      <Section id="actions" title="What you can do today">
        <ProfileActions />
      </Section>

      <Section id="contact" title="Found a gap?">
        <p>
          This page intentionally avoids fabricating data while the underlying indexer is being
          built. If you&apos;re routing material volume and want eligibility tracked before the
          public launch, reach out via the{' '}
          <TextLink href="https://business.ophis.fi" external>
            business page
          </TextLink>
          .
        </p>
        <p>
          Questions or feedback? Use the <TextLink href="/contact">contact form</TextLink>.
        </p>
      </Section>
    </PageShell>
  )
}
