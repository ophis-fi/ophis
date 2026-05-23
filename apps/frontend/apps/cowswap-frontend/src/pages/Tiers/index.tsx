/**
 * Tiers — trader ladder / volume-based recognition framework (DRAFT v1).
 *
 * Phase A3 rebuild (PR #252, 2026-05-23). The prior version used local
 * styled-components and presented draft figures as if they were a
 * committed program. This rewrite:
 *   - Frames the entire ladder as DRAFT, not yet live
 *   - Uses status Badges aggressively on every tier and perk
 *   - Centers the page on "register interest" rather than "claim rewards"
 *   - Uses the Table primitive for the tier matrix so volumes / perks
 *     are scannable
 *
 * This page does NOT make a binding promise. The infrastructure to
 * track wallet volume + apply fee discounts + provide tiered support
 * does not exist as of 2026-05-23. The page exists to capture early
 * interest from material-volume traders.
 */
import { ReactNode } from 'react'

import {
  Badge,
  Callout,
  FeatureCard,
  FeatureGrid,
  InlineCode,
  PageShell,
  Section,
  Table,
  Tbody,
  Td,
  TextLink,
  Th,
  Thead,
  Tr,
} from 'ophis/ds'

export default function TiersPage(): ReactNode {
  return (
    <PageShell
      width="medium"
      eyebrow="Tiers — draft framework"
      title="A recognition ladder, not a yield program."
      lede="Planned framework to recognize traders routing serious volume through Ophis. Indicative draft below — nothing on this page is a binding commitment."
    >
      <Callout tone="planned" title="Status: planned, not yet live">
        Tier infrastructure (volume indexer, automatic fee-discount enforcement at the order
        layer, partner perk distribution) is targeted for <strong>Q3 2026</strong>. Volume
        thresholds, fee discounts, perk lists, and unlock semantics shown below are{' '}
        <em>indicative draft values, subject to change</em> before launch. <Badge tone="draft">
          draft
        </Badge>
      </Callout>

      <Section
        id="ladder"
        title="The ladder (draft)"
        intro="Four tiers indexed on cumulative volume. Recognition framework — not a yield program."
      >
        <FeatureGrid minCardWidth="240px">
          <FeatureCard title="Stargazer" footer={<Badge tone="draft">draft</Badge>}>
            <p>
              <InlineCode>&lt; $10k cumulative</InlineCode>
            </p>
            <ul>
              <li>Default fees: 0% on trades, 25% of price improvement above quote (live).</li>
              <li>Intent API: 30 req/min/IP (live).</li>
              <li>Standard solver routing across 13 EVM chains (live).</li>
            </ul>
          </FeatureCard>
          <FeatureCard title="Navigator" footer={<Badge tone="draft">draft</Badge>}>
            <p>
              <InlineCode>$10k–$100k cumulative</InlineCode>
            </p>
            <ul>
              <li>~15% off the price-improvement fee tier (target).</li>
              <li>Intent API: 60 req/min (planned).</li>
              <li>Priority on the in-flight order queue (planned).</li>
              <li>NEAR Intents cross-chain destinations promoted in token picker (planned).</li>
            </ul>
          </FeatureCard>
          <FeatureCard title="Orbiter" footer={<Badge tone="draft">draft</Badge>}>
            <p>
              <InlineCode>$100k–$1M cumulative</InlineCode>
            </p>
            <ul>
              <li>~30% off the price-improvement fee tier (target).</li>
              <li>Intent API: 180 req/min (planned).</li>
              <li>Custom rate-limit increases on request (partner-dependent).</li>
              <li>Direct channel to the team for solver-routing questions (partner-dependent).</li>
            </ul>
          </FeatureCard>
          <FeatureCard title="Cosmonaut" footer={<Badge tone="draft">draft</Badge>}>
            <p>
              <InlineCode>$1M+ cumulative</InlineCode>
            </p>
            <ul>
              <li>~50% off the price-improvement fee tier (target).</li>
              <li>White-glove integration support (partner-dependent).</li>
              <li>Co-marketing opportunities (partner-dependent).</li>
              <li>Eligibility for OTC routing partnership terms (partner-dependent).</li>
            </ul>
          </FeatureCard>
        </FeatureGrid>
      </Section>

      <Section
        id="comparison"
        title="At a glance"
        intro="Tier perks matrix. All figures are draft."
      >
        <Table>
          <Thead>
            <Tr>
              <Th>Tier</Th>
              <Th>Volume</Th>
              <Th>Fee discount</Th>
              <Th>Intent API</Th>
              <Th>Direct channel</Th>
            </Tr>
          </Thead>
          <Tbody>
            <Tr>
              <Td>Stargazer</Td>
              <Td>&lt; $10k</Td>
              <Td>—</Td>
              <Td>30 / min</Td>
              <Td>Public only</Td>
            </Tr>
            <Tr>
              <Td>Navigator</Td>
              <Td>$10k – $100k</Td>
              <Td>~15%</Td>
              <Td>60 / min</Td>
              <Td>Public only</Td>
            </Tr>
            <Tr>
              <Td>Orbiter</Td>
              <Td>$100k – $1M</Td>
              <Td>~30%</Td>
              <Td>180 / min</Td>
              <Td>Yes</Td>
            </Tr>
            <Tr>
              <Td>Cosmonaut</Td>
              <Td>$1M+</Td>
              <Td>~50%</Td>
              <Td>Custom</Td>
              <Td>Yes</Td>
            </Tr>
          </Tbody>
        </Table>
      </Section>

      <Section id="how-it-works" title="How it&#39;s expected to work">
        <p>
          At launch, cumulative volume is expected to be measured across trades signed by your
          wallet address on Ophis-supported chains. The current draft has tier upgrades unlocking
          automatically with no within-year downgrades, but final semantics depend on the
          on-chain implementation choice (subgraph indexer vs. direct event log) and may change.
        </p>
        <p>
          The ladder is framed as a <strong>recognition framework</strong>, not a yield program.
          Higher tiers are expected to unlock features (lower fees, higher API quotas, direct
          team access) rather than direct token payouts. Final fee-discount mechanics, claim
          flow, and on-chain reward distribution (if any) are TBD.
        </p>
        <Callout tone="warning" title="Not a financial-services offering">
          The Tiers framework does NOT create a financial product, security, or claim against
          the operator. Fee discounts (if and when launched) apply at the order-routing layer
          — they reduce the partner-fee captured by the operator on your trades, not a token
          payout, NFT, airdrop, or other financial instrument.
        </Callout>
      </Section>

      <Section id="register-interest" title="Register early interest">
        <p>
          If you&#39;re routing material volume today (or expect to), let us know via the{' '}
          <TextLink href="/institutional">Institutional page</TextLink> so we can track you for
          potential retroactive eligibility at launch.
        </p>
        <p>
          Direct contact:{' '}
          <TextLink href="mailto:clement@openletz.com?subject=Ophis%20Tiers%20interest">
            clement@openletz.com
          </TextLink>{' '}
          (Subject: Ophis Tiers interest). Operator entity for any formal arrangement: COMMIT
          MEDIA S.à r.l. (Luxembourg, RCS B276192) — full disclosure on{' '}
          <TextLink href="/legal#operator">/legal § 8</TextLink>.
        </p>
      </Section>
    </PageShell>
  )
}
