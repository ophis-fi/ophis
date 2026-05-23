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
 * Real backend (volume indexer, tier auto-progression, partner perks,
 * Missions/Earn integration) is targeted for Q3 2026 per the /tiers page.
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

import {
  Badge,
  Callout,
  FeatureGrid,
  InlineCode,
  KeyValueList,
  MetricCard,
  PageShell,
  Section,
  TextLink,
} from 'ophis/ds'

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
      eyebrow="Profile — draft framework"
      title="Wallet-aware identity. Honest about what's live."
      lede="Connect a wallet to see your address and current app chain. Trading history, tier eligibility, and partner perks are planned for Q3 2026 — until then, nothing on this page pretends to be a record we hold."
    >
      <Callout tone="info" title="Data sources">
        <p>
          <strong>Read locally from your wallet:</strong> address, current app chain, wallet
          provider name. Nothing is sent to Ophis servers for this section to render.{' '}
          <strong>Resolved via public RPC:</strong> ENS name (if any) is looked up against the
          public ENS registry.
        </p>
        <p>
          <strong>Not yet indexed:</strong> historical trade volume, tier eligibility, partner
          rewards. The on-chain trade indexer launches Q3 2026; no figures appear here in the
          meantime. <Badge tone="draft">draft</Badge>
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
                    '—'
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

      <Section
        id="tier"
        title="Tier framework"
        intro="Default-state view of the volume-tier ladder. No tier is computed for your wallet until the indexer is live."
      >
        <FeatureGrid minCardWidth="260px" gap="20px">
          <MetricCard
            label="Default framework tier"
            value="Stargazer"
            sublabel="< $10k cumulative · indexer not yet live"
          />
        </FeatureGrid>
        <KeyValueList
          items={[
            { label: 'Indexed volume', value: 'Not yet indexed' },
            { label: 'Next threshold (draft)', value: '$10k cumulative → Navigator' },
            { label: 'Tracking launch', value: 'Q3 2026 planned' },
            {
              label: 'Retroactive eligibility',
              value: 'May be reviewed at launch — not a binding promise',
            },
          ]}
        />
        <p>
          The full draft ladder (volume bands, target fee discounts, perk classes) lives on the{' '}
          <TextLink href="/tiers">Tiers page</TextLink>. Until the volume indexer ships, no tier
          is auto-assigned to your wallet, and the figures above are framework defaults — not a
          read of your activity.
        </p>
      </Section>

      <Section
        id="history"
        title="Trade history"
        intro={
          <>
            <Badge tone="planned">planned</Badge>&nbsp;On-chain trade indexer is planned for Q3
            2026.
          </>
        }
      >
        <Callout tone="planned" title="Until the indexer ships">
          <p>
            Your trade history lives in your wallet&apos;s transaction view and on each
            chain&apos;s public block explorer. Ophis does not currently index trades — nothing
            on this page is a record of activity we hold.
          </p>
          <p>
            When the indexer goes live, this section will surface order history, settlement
            receipts, and aggregate volume across chains.
          </p>
        </Callout>
        {account && explorerUrl && (
          <p>
            For the current app chain ({chain?.label ?? `#${chainId}`}), view transactions
            directly on the app-chain explorer:{' '}
            <TextLink href={explorerUrl} external>
              {chain?.explorerTitle ?? 'block explorer'}
            </TextLink>
            .
          </p>
        )}
      </Section>

      <Section
        id="perks"
        title="Partner perks"
        intro={
          <>
            <Badge tone="planned">planned</Badge>&nbsp;Launches alongside Missions + Earn pages
            (Phase C2 + C3).
          </>
        }
      >
        <Callout tone="planned" title="No partner perks shown by design">
          <p>
            Future perk cards will appear here only after signed partner terms exist. Showing
            placeholder discounts now — even as a layout preview — would be dishonest: there are
            no live partner integrations yet.
          </p>
          <p>
            Real integrations launch with the upcoming <em>Missions</em> (partner protocol
            integrations) and <em>Earn</em> (rewards from partner programs) pages.
          </p>
        </Callout>
      </Section>

      <Section id="contact" title="Found a gap?">
        <p>
          This page intentionally avoids fabricating data while the underlying indexer is being
          built. If you&apos;re routing material volume and want eligibility tracked before the
          public launch, reach out via the{' '}
          <TextLink href="/institutional">Institutional page</TextLink>.
        </p>
        <p>
          Direct contact:{' '}
          <TextLink href="mailto:contact@3615crypto.com?subject=Ophis%20Profile%20feedback">
            contact@3615crypto.com
          </TextLink>
          .
        </p>
      </Section>
    </PageShell>
  )
}
