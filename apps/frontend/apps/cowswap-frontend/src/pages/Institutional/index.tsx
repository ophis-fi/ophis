/**
 * Institutional / Professional clients — pitch page for OTC desks,
 * funds, treasuries, and integrators.
 *
 * Phase A3 rebuild (PR #251, 2026-05-23). Replaces local
 * styled-components with ophis/ds primitives. The prior page mixed
 * live claims with aspirational ones; this rewrite separates them with
 * live/planned/draft Badges per Codex 2026-05-23 guidance.
 *
 * KEY DESIGN CHOICE: every feature claim carries a Badge stating
 * whether it's currently shipped, planned, or partner-dependent.
 * Claims without operational backing (custom rate limits, SLA,
 * white-glove support) are explicitly draft / partner-dependent so
 * the page doesn't function as a sales pitch the operator can't
 * deliver on.
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

export default function InstitutionalPage(): ReactNode {
  return (
    <PageShell
      width="medium"
      eyebrow="For institutions & professionals"
      title="Non-custodial routing. MEV protection. Audit references."
      lede="Built on audited DEX-aggregation infrastructure. No custody risk, no proprietary spread, transparent solver competition."
    >
      <Callout tone="info" title="Reality check on claims">
        Each feature below carries a status Badge — <Badge tone="live">live</Badge> for shipped,{' '}
        <Badge tone="planned">planned</Badge> for roadmap items, <Badge tone="partner">partner</Badge>{' '}
        for items dependent on a partner agreement. Use this page to evaluate Ophis honestly — we
        don&#39;t pitch features we can&#39;t deliver.
      </Callout>

      <Section id="why" title="Why desks &amp; treasuries use Ophis">
        <FeatureGrid minCardWidth="280px">
          <FeatureCard title="Non-custodial" footer={<Badge tone="live">live</Badge>}>
            Your tokens never leave your wallet until on-chain settlement. The operator cannot
            move, freeze, or recover funds. No counterparty custody risk.
          </FeatureCard>
          <FeatureCard title="MEV-protected by construction" footer={<Badge tone="live">live</Badge>}>
            Every order settles inside a batch auction at a uniform clearing price.
            Front-running and sandwich attacks are designed-out — no priority-gas auction to
            lose against.
          </FeatureCard>
          <FeatureCard title="Audited infrastructure" footer={<Badge tone="live">live</Badge>}>
            Settlement layer is CoW Protocol&#39;s GPv2 contracts (Trail of Bits + G0 upstream
            audits). Ophis-specific solver wiring + AllowList contract were reviewed via
            Slither, Codex Cyber, and the sharp-edges multi-agent pattern in May 2026. See{' '}
            <TextLink href="/about#audits">/about</TextLink>.
          </FeatureCard>
          <FeatureCard
            title="13 EVM chains + Solana + Bitcoin"
            footer={<Badge tone="live">live</Badge>}
          >
            Source from any major EVM chain. Cross-chain destinations to Solana and Bitcoin via
            NEAR Intents — no second wallet required.
          </FeatureCard>
          <FeatureCard
            title="Programmatic intent API"
            footer={<Badge tone="live">live</Badge>}
          >
            <InlineCode>POST /api/intent</InlineCode> turns plain-English requests into structured
            orders. 30 req/min/IP public rate limit, no auth, no key.
          </FeatureCard>
          <FeatureCard title="Transparent fees" footer={<Badge tone="live">live</Badge>}>
            0% on ordinary trades. 25% of price improvement above quote, capped at 0.5% of volume
            via the CIP-75 partner-fee mechanism. No hidden spreads, no surprise basis points.
          </FeatureCard>
        </FeatureGrid>
      </Section>

      <Section id="integration-paths" title="Integration paths">
        <FeatureGrid minCardWidth="280px">
          <FeatureCard title="Direct use" footer={<Badge tone="live">live</Badge>}>
            Your desk operators trade via the standard web UI at{' '}
            <InlineCode>ophis.fi</InlineCode>. Wallet connect via MetaMask, WalletConnect v2,
            Coinbase Wallet, Safe, or any EIP-1193 provider.
          </FeatureCard>
          <FeatureCard title="Intent API" footer={<Badge tone="live">live</Badge>}>
            Hit <InlineCode>POST /api/intent</InlineCode> from your bot or agent — Ophis returns
            a structured order ready to sign. Settle on-chain via the underlying CoW Protocol
            orderbook.
          </FeatureCard>
          <FeatureCard
            title="CoW Widget embed"
            footer={<Badge tone="partner">upstream-supported</Badge>}
          >
            The upstream CoW Widget embeds the swap form in your app. Inherits the MEV-protected
            routing + 13-chain coverage. Available via <InlineCode>@cowprotocol/widget-react</InlineCode>.
            Ophis-branded variant is not yet available.
          </FeatureCard>
        </FeatureGrid>
      </Section>

      <Section
        id="api-overview"
        title="API + rate-limit overview"
        intro="The public Intent API. Higher tiers + custom rate increases are partner-dependent and not currently exposed."
      >
        <Table>
          <Thead>
            <Tr>
              <Th>Endpoint</Th>
              <Th>Method</Th>
              <Th>Auth</Th>
              <Th>Rate limit</Th>
              <Th>Status</Th>
            </Tr>
          </Thead>
          <Tbody>
            <Tr>
              <Td><InlineCode>/api/intent</InlineCode></Td>
              <Td>POST</Td>
              <Td>None</Td>
              <Td>30 / min / IP</Td>
              <Td><Badge tone="live">live</Badge></Td>
            </Tr>
            <Tr>
              <Td><InlineCode>/api/intent</InlineCode></Td>
              <Td>POST</Td>
              <Td>API key (partner)</Td>
              <Td>180 / min</Td>
              <Td><Badge tone="planned">planned</Badge></Td>
            </Tr>
            <Tr>
              <Td><InlineCode>/api/quote</InlineCode></Td>
              <Td>POST</Td>
              <Td>None</Td>
              <Td>—</Td>
              <Td><Badge tone="planned">planned</Badge></Td>
            </Tr>
            <Tr>
              <Td>CoW orderbook API</Td>
              <Td>HTTP</Td>
              <Td>None</Td>
              <Td>Upstream-defined</Td>
              <Td><Badge tone="live">live (upstream)</Badge></Td>
            </Tr>
          </Tbody>
        </Table>
        <Callout tone="info">
          Full reference at <TextLink href="/docs">/docs</TextLink>. Public-tier rate limits are
          adequate for low/medium-volume operators today. For higher-throughput needs, reach out
          via the contact below — partner rate increases are reviewed case-by-case.
        </Callout>
      </Section>

      <Section
        id="support-sla"
        title="Support, SLA &amp; OTC routing"
        intro="Current state, honestly stated."
      >
        <FeatureGrid minCardWidth="280px">
          <FeatureCard
            title="Public best-effort"
            footer={<Badge tone="live">live</Badge>}
          >
            GitHub issues + email response within 1 business day. No formal SLA. The interface is
            best-effort; downtime, RPC outages, or upstream protocol issues may affect availability.
          </FeatureCard>
          <FeatureCard
            title="Partner-tier support"
            footer={<Badge tone="partner">partner</Badge>}
          >
            Direct Telegram / email channel, higher rate limits, integration assistance. Available
            on case-by-case basis for material volume routing through Ophis. Not a public tier.
          </FeatureCard>
          <FeatureCard
            title="OTC routing partnership"
            footer={<Badge tone="partner">partner</Badge>}
          >
            Custom solver-set composition, dedicated execution lanes, post-trade reporting. Requires
            a formal partnership agreement. Reach out to discuss scope + terms.
          </FeatureCard>
          <FeatureCard
            title="Formal SLA"
            footer={<Badge tone="planned">planned</Badge>}
          >
            No formal uptime SLA today. Operator is a Luxembourg consultancy company (not a
            regulated financial-services entity); SLA negotiation requires a written agreement.
          </FeatureCard>
        </FeatureGrid>
      </Section>

      <Section
        id="contact"
        title="Talk to us"
        intro="For OTC integrations, custom rate-limit needs, or partnership terms — direct contact only. No sales funnel."
      >
        <Callout tone="planned" title="Response expectations">
          One business day for substantive inquiries. We don&#39;t cold-pitch and we don&#39;t
          chase. If our public model fits your desk, the conversation is short; if it
          doesn&#39;t, we&#39;ll tell you straight.
        </Callout>
        <p>
          Email:{' '}
          <TextLink href="mailto:clement@openletz.com?subject=Ophis%20Institutional%20Inquiry">
            clement@openletz.com
          </TextLink>{' '}
          (Subject: Ophis Institutional Inquiry).
        </p>
        <p>
          Operator entity for contract / invoicing purposes: COMMIT MEDIA S.à r.l. (Luxembourg,
          RCS B276192). Full disclosure on <TextLink href="/legal#operator">/legal § 8</TextLink>.
        </p>
      </Section>
    </PageShell>
  )
}
