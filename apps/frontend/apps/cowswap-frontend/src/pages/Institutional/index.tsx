/**
 * Ophis Institutional / Professional clients page.
 *
 * Created in PR #240 closing Clement's 2026-05-22 brand task #10
 * (Missing institutional / professional clients page). Pitches the
 * non-custodial, MEV-protected, batch-settled UX to OTC desks, funds,
 * treasuries, and integrators.
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
  line-height: 1.65;
  font-size: 16px;

  @media (max-width: 600px) {
    padding: 32px 18px 56px;
    font-size: 15px;
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
  margin-top: 40px;
`

const H2 = styled.h2`
  font-family: 'Fraunces', var(--cow-font-family-primary, system-ui);
  font-weight: 500;
  font-size: 24px;
  margin: 0 0 14px;
  color: #f5efe6;
`

const FeatureGrid = styled.div`
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 16px;
  margin-top: 12px;
`

const FeatureCard = styled.div`
  border-radius: 12px;
  padding: 22px 20px;
  background: rgba(245, 239, 230, 0.04);
  border: 1px solid rgba(245, 239, 230, 0.08);

  & h3 {
    margin: 0 0 8px;
    font-family: 'Fraunces', var(--cow-font-family-primary, system-ui);
    font-weight: 500;
    font-size: 17px;
    color: #f2a63e;
  }

  & p {
    margin: 0;
    font-size: 14px;
    color: rgba(245, 239, 230, 0.7);
    line-height: 1.55;
  }
`

const CtaSection = styled.div`
  margin-top: 48px;
  padding: 32px 28px;
  border-radius: 16px;
  background: linear-gradient(135deg, rgba(242, 166, 62, 0.12) 0%, rgba(79, 29, 202, 0.08) 100%);
  border: 1px solid rgba(242, 166, 62, 0.25);
  display: flex;
  flex-direction: column;
  gap: 14px;

  & h2 {
    margin: 0;
    font-family: 'Fraunces', var(--cow-font-family-primary, system-ui);
    font-weight: 500;
    font-size: 24px;
    color: #f5efe6;
  }

  & p {
    margin: 0;
    color: rgba(245, 239, 230, 0.78);
    line-height: 1.55;
  }
`

const CtaButton = styled.a`
  align-self: flex-start;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 12px 22px;
  border-radius: 999px;
  font-family: 'Plus Jakarta Sans', var(--cow-font-family-primary, system-ui);
  font-weight: 600;
  font-size: 14px;
  background: #f2a63e;
  color: #02000d;
  text-decoration: none;
  transition: filter 140ms ease-out;

  &:hover {
    filter: brightness(1.06);
  }
`

export default function InstitutionalPage(): ReactNode {
  return (
    <Page>
      <OphisHeader />
      <Container>
        <Title>For institutions &amp; professionals</Title>
        <Lede>
          Non-custodial routing, MEV-protected execution, programmatic intent parsing — built on
          audited DEX-aggregation infrastructure.
        </Lede>

        <Section>
          <H2>Why desks &amp; treasuries use Ophis</H2>
          <FeatureGrid>
            <FeatureCard>
              <h3>Non-custodial</h3>
              <p>
                Your tokens never leave your wallet until on-chain settlement. No counterparty
                custody risk, no exchange withdrawal queue.
              </p>
            </FeatureCard>
            <FeatureCard>
              <h3>MEV-protected by construction</h3>
              <p>
                Every order is settled inside a batch auction at a uniform clearing price. No
                front-running, no sandwich attacks, no priority-gas-auction loss.
              </p>
            </FeatureCard>
            <FeatureCard>
              <h3>Audited infrastructure</h3>
              <p>
                Settlement layer is the GPv2 contracts from CoW Protocol, audited by Trail of Bits
                and G0. Ophis-specific solver wiring re-audited via Slither, Halmos, Codex Cyber.
              </p>
            </FeatureCard>
            <FeatureCard>
              <h3>13 EVM chains + Solana + Bitcoin</h3>
              <p>
                Source from any major EVM chain. Cross-chain destinations via NEAR Intents for
                Solana and Bitcoin without a second wallet.
              </p>
            </FeatureCard>
            <FeatureCard>
              <h3>Programmatic intent API</h3>
              <p>
                <code>POST /api/intent</code> turns plain-English requests into structured orders.
                30 req/min/IP, no auth, no key. Embed in agent frameworks or your own UI.
              </p>
            </FeatureCard>
            <FeatureCard>
              <h3>Transparent fees</h3>
              <p>
                0% on ordinary trades. 25% of price improvement above quote, capped at 0.5% of
                volume. No hidden spreads, no surprise basis points.
              </p>
            </FeatureCard>
          </FeatureGrid>
        </Section>

        <Section>
          <H2>Integration paths</H2>
          <FeatureGrid>
            <FeatureCard>
              <h3>Direct use</h3>
              <p>
                Your desk operators trade via the standard web UI at <code>ophis.fi</code>. Wallet
                connect via MetaMask, WalletConnect v2, Coinbase Wallet, Safe, or any EIP-1193
                provider. No onboarding form, no KYC at the interface layer.
              </p>
            </FeatureCard>
            <FeatureCard>
              <h3>Programmatic via intent API</h3>
              <p>
                Hit <code>POST /api/intent</code> from your bot or agent — Ophis returns a
                structured order ready to sign. Settle on-chain via the underlying CoW Protocol
                orderbook.
              </p>
            </FeatureCard>
            <FeatureCard>
              <h3>White-label widget</h3>
              <p>
                CoW Widget (upstream) embeds the swap form in your app. Inherit Ophis&#39;s MEV
                protection + 13-chain routing without rebuilding the UX. Available via
                <code> @cowprotocol/widget-react</code>.
              </p>
            </FeatureCard>
          </FeatureGrid>
        </Section>

        <CtaSection>
          <h2>Talk to us</h2>
          <p>
            For OTC integrations, custom rate-limit increases on the intent API, or volume-based
            partnership terms, reach out directly. We respond within one business day.
          </p>
          <CtaButton href="mailto:clement@openletz.com?subject=Ophis%20Institutional%20Inquiry">
            clement@openletz.com →
          </CtaButton>
        </CtaSection>
      </Container>
      <OphisFooter />
    </Page>
  )
}
