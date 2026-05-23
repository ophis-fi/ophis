/**
 * Earn — draft rewards catalogue page (Phase C3, 2026-05-23).
 *
 * IA decision (Codex 2026-05-23): NOT a yield aggregator or claim page.
 * Jumper's /earn is a DeFi yield front-end (Aave / Yearn / etc.). Ophis
 * has zero yield products and is a DEX aggregator, not a lending market.
 *
 * Instead: a CATALOGUE of reward TYPES Ophis may support after volume
 * indexing + signed partner terms are live. Distinct from sibling pages:
 *   /tiers      — eligibility ladder
 *   /missions   — qualification mechanisms
 *   /profile    — wallet-specific status
 *   /earn       — reward/perk taxonomy   ← this page
 *
 * Codex pre-flight rules applied:
 *   - Title is anti-marketing: "Rewards catalogue. Nothing is claimable today."
 *   - "Earn" route name is itself risky; counteracted in the title + top callout.
 *   - 4 categories: Fee discounts / Partner discounts / Recognition tags /
 *     Material-volume terms (renamed from "Institutional terms" — clearer
 *     it's not something normal users "earn").
 *   - "Not a yield or airdrop page" negative-scope section.
 *   - 3 distribution mechanisms: Order-time application / Partner-side
 *     fulfillment / Off-app agreement.
 *   - Non-retroactive footer matches /missions.
 *   - "Could make available under live terms" — never "will flow".
 *
 * AGENTS.md compliance (proactive — same constraints as PR #255 Profile):
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

export function EarnPage(): ReactNode {
  return (
    <PageShell
      width="medium"
      eyebrow="Earn — draft rewards catalogue"
      title="Rewards catalogue. Nothing is claimable today."
      lede="This page documents reward categories Ophis may support after volume indexing and signed partner terms are live. It is not a yield product, a points program, or a claim page."
    >
      <Callout tone="planned" title="Status — nothing claimable">
        <p>
          <strong>No claimable rewards. No active distributions.</strong> No tokens, NFTs,
          airdrops, or APY products. This page exists to make the catalogue of categories
          transparent — so users know what Ophis may eventually support, and what it will not.{' '}
          <Badge tone="draft">draft</Badge>
        </p>
      </Callout>

      <Section
        id="categories"
        title="Reward categories (planned)"
        intro="The categories Ophis could make available under live terms. Each describes a mechanism, not a specific dollar value."
      >
        <FeatureGrid minCardWidth="280px">
          <FeatureCard title="Fee discounts" footer={<Badge tone="planned">planned</Badge>}>
            <p>
              The native Ophis perk shape. Once volume indexing is live, qualifying tiers may
              reduce the partner-fee captured at order routing. Discount applies during settlement
              — no claim step.
            </p>
            <p>
              Discount percentages are draft targets only; see{' '}
              <TextLink href="/tiers">/tiers</TextLink> for the indicative ladder.
            </p>
          </FeatureCard>
          <FeatureCard title="Partner discounts" footer={<Badge tone="planned">planned</Badge>}>
            <p>
              Where a partner protocol or program signs formal terms with Ophis, the partner may
              honor a discount or credit. Delivery is partner-side (via their UI under their
              terms) — Ophis does not custody or distribute partner inventory.
            </p>
            <p>No signed partner terms exist today. No partner discounts are listed here.</p>
          </FeatureCard>
          <FeatureCard title="Recognition tags" footer={<Badge tone="planned">planned</Badge>}>
            <p>
              Labels, not monetary. Multi-chain participation, tier rung, or onboarding-readiness
              status may be recorded in a future profile / status surface once the indexer ships.
            </p>
            <p>
              Recognition is not a reward — it is metadata that may inform partner eligibility or
              institutional contact later.
            </p>
          </FeatureCard>
          <FeatureCard
            title="Material-volume terms"
            footer={<Badge tone="planned">planned</Badge>}
          >
            <p>
              For desks, funds, and high-volume teams, Ophis may route qualified opportunities
              into institutional conversations. Outcomes are contractual, not automatic;
              regular users do not unlock OTC terms through volume alone.
            </p>
            <p>
              See <TextLink href="/institutional">/institutional</TextLink> for current scope.
            </p>
          </FeatureCard>
        </FeatureGrid>
      </Section>

      <Section
        id="not-here"
        title="Not a yield or airdrop page"
        intro="Counter-scope. What you will not find on /earn."
      >
        <KeyValueList
          items={[
            { label: 'No tokens', value: 'Ophis does not have a token; no token rewards.' },
            { label: 'No NFTs', value: 'No NFT mints, no NFT airdrops, no NFT memberships.' },
            {
              label: 'No airdrops',
              value: 'No airdrop claim flow, no retroactive token distribution.',
            },
            {
              label: 'No yield product',
              value:
                'Ophis is a DEX aggregator, not a yield aggregator or lending market. No APY pools.',
            },
            {
              label: 'No leaderboards',
              value: 'No public ranking, no points-board competition between traders.',
            },
            {
              label: 'No speculative APY',
              value:
                'Fee discounts are deterministic reductions on a known fee — not yield, not interest.',
            },
          ]}
        />
      </Section>

      <Section
        id="distribution"
        title="How distribution would work (planned)"
        intro="Three mechanism shapes for the reward categories above. None active today."
      >
        <FeatureGrid minCardWidth="280px">
          <FeatureCard title="Order-time application">
            <p>
              For fee discounts: applied automatically during order routing. No claim flow, no
              transaction, no wallet interaction beyond the trade itself.
            </p>
          </FeatureCard>
          <FeatureCard title="Partner-side fulfillment">
            <p>
              For partner discounts: the partner honors the discount or credit through their own
              UI per signed terms. Ophis surfaces eligibility; partner controls delivery.
            </p>
          </FeatureCard>
          <FeatureCard title="Off-app agreement">
            <p>
              For material-volume terms: handled by direct contract or commercial process. Not
              auto-unlocked; involves a conversation with the operator.
            </p>
          </FeatureCard>
        </FeatureGrid>
      </Section>

      <Section id="cross-refs" title="Related">
        <KeyValueList
          items={[
            {
              label: 'Tiers',
              value: (
                <TextLink href="/tiers">
                  /tiers — eligibility ladder (what determines your level)
                </TextLink>
              ),
            },
            {
              label: 'Institutional',
              value: (
                <TextLink href="/institutional">
                  /institutional — material-volume contact + scope
                </TextLink>
              ),
            },
            {
              label: 'Missions',
              value:
                '/missions — qualification mechanisms. Wired in a separate PR (Phase C2); link will activate once that lands.',
            },
            {
              label: 'Profile',
              value:
                '/profile — wallet-aware status surface. Wired in a separate PR (Phase C1); link will activate once that lands.',
            },
          ]}
        />
      </Section>

      <Callout tone="warning">
        <p>
          <strong>Non-retroactive default.</strong> Past activity does not automatically qualify
          for future rewards unless a live program explicitly says so. Nothing on this page is a
          binding commitment to credit you later.
        </p>
      </Callout>
    </PageShell>
  )
}
