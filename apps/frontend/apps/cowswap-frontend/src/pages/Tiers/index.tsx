/**
 * Ophis Tiers / Trader ladder page.
 *
 * Created in PR #240 closing Clement's 2026-05-22 brand task #13
 * (Need a ladder for traders/users). v1: static tier table outlining
 * the planned ladder structure. Real point tracking + on-chain rewards
 * are a separate sprint (estimate: months) tracked in a follow-up issue.
 *
 * Intentionally framed as "Tiers" not "Rewards" — sets expectation that
 * the ladder is a recognition framework, not a yield program. Volume-
 * based tiers unlock features (lower fees, higher API quotas) rather
 * than direct token payouts.
 */
import { ReactNode } from 'react'

import styled from 'styled-components/macro'

import { OphisFooter } from 'ophis/components/OphisFooter'
import { OphisHeader } from 'ophis/components/OphisHeader'

const Page = styled.main`
  width: 100vw;
  margin-left: calc(50% - 50vw);
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  background-color: #02000d;
  color: #f5efe6;
  font-family: 'Plus Jakarta Sans', var(--cow-font-family-primary, system-ui);
`

const Container = styled.section`
  flex: 1;
  width: min(880px, 100%);
  margin: 0 auto;
  padding: 64px 24px 96px;

  @media (max-width: 600px) {
    padding: 32px 18px 56px;
  }
`

const Title = styled.h1`
  font-family: 'Fraunces', var(--cow-font-family-primary, system-ui);
  font-weight: 500;
  font-size: clamp(36px, 5vw, 52px);
  margin: 0 0 8px;
  letter-spacing: -0.015em;
`

const Lede = styled.p`
  font-family: 'Fraunces', var(--cow-font-family-primary, system-ui);
  font-size: 20px;
  color: #f2a63e;
  font-style: italic;
  margin: 0 0 36px;
`

const Section = styled.section`
  margin-top: 36px;
`

const H2 = styled.h2`
  font-family: 'Fraunces', var(--cow-font-family-primary, system-ui);
  font-weight: 500;
  font-size: 24px;
  margin: 0 0 16px;
  color: #f5efe6;
`

const TierGrid = styled.div`
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 14px;
`

const TierCard = styled.div<{ $accent: string }>`
  border-radius: 14px;
  padding: 24px 22px;
  background: rgba(245, 239, 230, 0.04);
  border: 1px solid ${({ $accent }) => $accent};
  display: flex;
  flex-direction: column;
  gap: 12px;
  position: relative;

  & .tier-name {
    font-family: 'Fraunces', var(--cow-font-family-primary, system-ui);
    font-size: 22px;
    color: ${({ $accent }) => $accent};
    font-weight: 500;
  }

  & .tier-vol {
    font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, monospace;
    font-size: 12px;
    letter-spacing: 0.08em;
    color: rgba(245, 239, 230, 0.55);
    text-transform: uppercase;
  }

  & ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  & li {
    font-size: 13.5px;
    line-height: 1.5;
    color: rgba(245, 239, 230, 0.78);
    padding-left: 16px;
    position: relative;
  }

  & li::before {
    content: '·';
    position: absolute;
    left: 4px;
    color: ${({ $accent }) => $accent};
    font-weight: 700;
  }
`

const Note = styled.p`
  margin: 28px 0 0;
  font-size: 13px;
  line-height: 1.6;
  color: rgba(245, 239, 230, 0.55);
  padding: 16px 18px;
  border-radius: 12px;
  background: rgba(245, 239, 230, 0.04);
  border: 1px solid rgba(245, 239, 230, 0.08);
`

interface Tier {
  name: string
  volume: string
  accent: string
  perks: string[]
}

const TIERS: Tier[] = [
  {
    name: 'Stargazer',
    volume: '< $10k cumulative',
    accent: 'rgba(245, 239, 230, 0.3)',
    perks: [
      'Default fees: 0% on trades, 25% of price improvement above quote',
      'Intent API: 30 req/min/IP',
      'Standard solver routing across 13 EVM chains',
    ],
  },
  {
    name: 'Navigator',
    volume: '$10k–$100k cumulative',
    accent: '#F2A63E',
    perks: [
      '15% off the price-improvement fee tier',
      'Intent API: 60 req/min',
      'Priority on the in-flight order queue',
      'NEAR Intents cross-chain destinations promoted in token picker',
    ],
  },
  {
    name: 'Orbiter',
    volume: '$100k–$1M cumulative',
    accent: '#D960B5',
    perks: [
      '30% off the price-improvement fee tier',
      'Intent API: 180 req/min',
      'Custom rate-limit increases on request',
      'Direct Telegram channel to the team for solver-routing questions',
    ],
  },
  {
    name: 'Cosmonaut',
    volume: '$1M+ cumulative',
    accent: '#4F1DCA',
    perks: [
      '50% off the price-improvement fee tier',
      'White-glove integration support (CoW Widget embed, agent SDK)',
      'Co-marketing opportunities (case studies, joint research)',
      'Eligibility for OTC routing partnership terms',
    ],
  },
]

export default function TiersPage(): ReactNode {
  return (
    <Page>
      <OphisHeader />
      <Container>
        <Title>Tiers</Title>
        <Lede>
          Planned recognition framework for traders who route serious volume through Ophis.
        </Lede>
        <Note
          style={{
            margin: '0 0 32px',
            background: 'rgba(242, 166, 62, 0.08)',
            borderColor: 'rgba(242, 166, 62, 0.3)',
          }}
        >
          <strong>Status: planned, not yet live.</strong> Tier infrastructure is targeted for Q3
          2026. Volume thresholds, fee discounts, perk lists, and unlock semantics shown below are
          <em> indicative draft values, subject to change</em> before launch. Nothing on this page
          is a binding commitment.
        </Note>

        <Section>
          <H2>The ladder (draft)</H2>
          <TierGrid>
            {TIERS.map((tier) => (
              <TierCard key={tier.name} $accent={tier.accent}>
                <div className="tier-name">{tier.name}</div>
                <div className="tier-vol">{tier.volume}</div>
                <ul>
                  {tier.perks.map((perk, i) => (
                    <li key={i}>{perk}</li>
                  ))}
                </ul>
              </TierCard>
            ))}
          </TierGrid>
        </Section>

        <Section>
          <H2>How it&#39;s expected to work</H2>
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
        </Section>

        <Note>
          To register early interest as an OTC desk or large trader (so we can track you for
          potential retroactive eligibility at launch), reach out via the{' '}
          <a href="/institutional" style={{ color: '#f2a63e' }}>
            institutional page
          </a>
          .
        </Note>
      </Container>
      <OphisFooter />
    </Page>
  )
}
