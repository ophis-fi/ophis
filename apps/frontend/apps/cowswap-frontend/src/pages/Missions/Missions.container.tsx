/**
 * Missions — draft framework documentation page (Phase C2, 2026-05-23).
 *
 * IA decision (Codex 2026-05-23): NOT a marketplace-style /missions page
 * with Active / Completed / Locked tabs. That implies an operational
 * mission system with inventory state. Zero live missions exist today
 * — no signed partner terms, no volume indexer. So this page DOCUMENTS
 * the framework Ophis may operate after Q3 2026 instead of pretending
 * to list missions.
 *
 * Codex pre-flight rules applied:
 *   - Top-line copy explicit: "No live missions. No claimable rewards."
 *   - No countdown badges, no "X days left" UI (too campaign-coded).
 *   - No named partners except NEAR Intents (the only currently
 *     integrated cross-chain destination partner).
 *   - "Onboarding & readiness" instead of "education quests" — less
 *     fake-XP-coded.
 *   - Reward types list narrowed: tier credit / fee discount / partner
 *     discount / partner recognition. NO partner XP language.
 *   - Footer note locks down retroactive-reward expectations.
 *
 * AGENTS.md compliance (post-Codex GitHub bot audit on PR #256):
 *   - Named export (no default).
 *   - Page implementation in *.container.tsx, barrel in index.ts.
 */
import { ReactNode } from 'react'

import {
  Badge,
  Callout,
  FeatureCard,
  FeatureGrid,
  KeyValueList,
  PageShell,
  Section,
  TextLink,
} from 'ophis/ds'

export function MissionsPage(): ReactNode {
  return (
    <PageShell
      width="medium"
      eyebrow="Missions — draft framework"
      title="What missions will be. None are live."
      lede="Missions are time-bound or volume-bound challenges that may unlock recognition or partner perks once the underlying infrastructure is live. None exist today — this page documents the planned framework so you know what to expect."
    >
      <Callout tone="planned" title="Status — no live missions">
        <p>
          <strong>No live missions. No claimable rewards.</strong> Volume indexer is planned for
          Q3 2026 (see <TextLink href="/tiers">Tiers</TextLink>). No signed partner terms.
          No mission cards appear on this page until both the indexer and partner agreements
          exist. <Badge tone="draft">draft</Badge>
        </p>
      </Callout>

      <Section
        id="categories"
        title="Mission categories (planned)"
        intro="The shape of what missions may look like once the framework is live. These describe categories, not specific missions — no campaign on this page is committed."
      >
        <FeatureGrid minCardWidth="280px">
          <FeatureCard title="Volume challenges" footer={<Badge tone="planned">planned</Badge>}>
            <p>
              Once volume indexing is live, qualifying swap or routing activity through Ophis may
              count toward tier credit or fee discount eligibility.
            </p>
            <p>
              Volume thresholds, qualifying chains, and counting windows are not yet defined.
              Mechanics will be published before any live mission.
            </p>
          </FeatureCard>
          <FeatureCard
            title="Multi-chain recognition"
            footer={<Badge tone="planned">planned</Badge>}
          >
            <p>
              Use Ophis on multiple supported networks (EVM + Solana + Bitcoin via NEAR Intents),
              and the framework may record multi-chain participation as a recognition tag.
            </p>
            <p>
              Recognition is not a reward — it&apos;s a label that may inform partner eligibility
              or institutional contact later.
            </p>
          </FeatureCard>
          <FeatureCard
            title="Partner protocol missions"
            footer={<Badge tone="planned">planned</Badge>}
          >
            <p>
              Where a partner protocol agrees to formal terms with Ophis, a mission may surface
              here. Today the only integrated cross-chain destination partner is{' '}
              <strong>NEAR Intents</strong> — used for Solana and Bitcoin destinations from EVM
              source.
            </p>
            <p>No other partner missions are planned, scoped, or implied by this page.</p>
          </FeatureCard>
          <FeatureCard
            title="Onboarding &amp; readiness"
            footer={<Badge tone="planned">planned</Badge>}
          >
            <p>
              A self-attested checklist (reviewed <TextLink href="/about">About</TextLink>,{' '}
              <TextLink href="/tiers">Tiers</TextLink>, <TextLink href="/legal">Legal</TextLink>)
              may support institutional onboarding for partner conversations. Page reads are not
              tracked.
            </p>
            <p>Framed as onboarding, not XP. No points awarded for clicking a link.</p>
          </FeatureCard>
        </FeatureGrid>
      </Section>

      <Section
        id="lifecycle"
        title="Mission lifecycle (planned)"
        intro="The states a mission will move through once the framework is live."
      >
        <KeyValueList
          items={[
            { label: 'States', value: 'planned → live → expired' },
            {
              label: 'Eligibility',
              value: 'Wallet-based or app-chain-based, defined per mission at launch',
            },
            {
              label: 'Counting window',
              value: 'Per-mission. Past activity is not auto-counted unless a mission says so',
            },
            {
              label: 'Reward types (planned)',
              value: 'Tier credit · fee discount · partner discount · partner recognition',
            },
            {
              label: 'Reward types NOT planned',
              value: 'Tokens · NFTs · airdrops · leaderboards · partner-XP transfers',
            },
            { label: 'Claim flow', value: 'TBD — depends on each reward type and partner' },
          ]}
        />
      </Section>

      <Section
        id="partner-listings"
        title="How partners would get listed"
        intro="No pay-to-play. Plain-English terms before any card appears."
      >
        <p>The intended listing standard is:</p>
        <ol>
          <li>A partner protocol or program signs formal terms with Ophis.</li>
          <li>The mission&apos;s mechanics (eligibility, counting, reward) are documented.</li>
          <li>The infrastructure to track + honor it is live on Ophis&apos; side.</li>
        </ol>
        <p>
          The mission template + lifecycle code is targeted to be open-source so other CoW-fork
          deployments could fork the framework. Not a binding commitment — direction of travel
          only.
        </p>
      </Section>

      <Section
        id="suggest"
        title="Suggest a mission"
        intro="If you operate a protocol or program that would fit, or you&#39;re a user with a strong category idea — reach out."
      >
        <p>
          For partner introductions:{' '}
          <TextLink href="/institutional">/institutional</TextLink>. For specific mission ideas or
          framework feedback:{' '}
          <TextLink href="mailto:clement@openletz.com?subject=Ophis%20Missions%20idea">
            clement@openletz.com
          </TextLink>{' '}
          (Subject: Ophis Missions idea).
        </p>
      </Section>

      <Section id="cross-refs" title="Related">
        <KeyValueList
          items={[
            {
              label: 'Profile',
              value: (
                <TextLink href="/profile">
                  /profile — wallet-aware identity (live for connected wallet)
                </TextLink>
              ),
            },
            {
              label: 'Tiers',
              value: <TextLink href="/tiers">/tiers — draft volume ladder</TextLink>,
            },
            {
              label: 'Earn',
              value:
                'Planned (Phase C3). Expected to document partner rewards if any are signed and shipped.',
            },
            {
              label: 'About',
              value: <TextLink href="/about">/about — what&#39;s live vs planned</TextLink>,
            },
          ]}
        />
      </Section>

      <Callout tone="warning">
        <p>
          <strong>Non-retroactive default.</strong> Mission eligibility, rewards, and partner
          availability are not retroactive unless a future live mission explicitly says so. Past
          activity does not auto-qualify; nothing on this page is a binding commitment to credit
          you later.
        </p>
      </Callout>
    </PageShell>
  )
}
