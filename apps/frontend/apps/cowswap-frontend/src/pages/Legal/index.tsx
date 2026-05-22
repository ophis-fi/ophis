/**
 * Ophis Legal page — Terms of Service + Privacy Policy + legal entity
 * disclosure.
 *
 * Static single-page document; no backend. Layout mirrors the cosmic
 * landing/footer chrome from `ophis/components/{OphisHeader,OphisFooter}`
 * so the visual identity is consistent across all surfaces.
 *
 * Created in PR #234 closing Clement's 2026-05-22 brand task #7
 * (Missing legal page). Legal-entity values are the canonical Commit
 * Media S.à r.l. record per memory `reference_commit_media_legal.md`.
 */
import { ReactNode } from 'react'

import styled from 'styled-components/macro'

// PR #245 (2026-05-23): OphisHeader + OphisFooter come from AppContainer.

const Page = styled.main`
  width: 100%;
  display: flex;
  flex-direction: column;
  color: #f5efe6;
  font-family: 'Plus Jakarta Sans', var(--cow-font-family-primary, system-ui);
`

const Container = styled.section`
  flex: 1;
  width: min(820px, 100%);
  margin: 0 auto;
  padding: 64px 24px 96px;
  line-height: 1.7;
  font-size: 15px;

  @media (max-width: 600px) {
    padding: 32px 18px 56px;
    font-size: 14.5px;
  }
`

const Title = styled.h1`
  font-family: 'Fraunces', var(--cow-font-family-primary, system-ui);
  font-weight: 500;
  font-size: clamp(32px, 4.5vw, 48px);
  margin: 0 0 8px;
  letter-spacing: -0.015em;
`

const Lede = styled.p`
  color: rgba(245, 239, 230, 0.7);
  margin: 0 0 36px;
`

const Section = styled.section`
  margin-top: 32px;
`

const H2 = styled.h2`
  font-family: 'Fraunces', var(--cow-font-family-primary, system-ui);
  font-weight: 500;
  font-size: 22px;
  margin: 0 0 12px;
  color: #f2a63e;
`

const Dl = styled.dl`
  margin: 0;
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 6px 16px;
  font-size: 14px;
`

const Dt = styled.dt`
  color: rgba(245, 239, 230, 0.55);
`

const Dd = styled.dd`
  margin: 0;
`

const Last = styled.p`
  margin: 40px 0 0;
  color: rgba(245, 239, 230, 0.45);
  font-size: 13px;
`

export default function LegalPage(): ReactNode {
  return (
    <Page>
      <Container>
        <Title>Legal</Title>
        <Lede>
          Terms of service, privacy policy, and legal-entity disclosure for the Ophis interface
          operated at <code>ophis.fi</code>.
        </Lede>

        <Section>
          <H2>Terms of Service</H2>
          <p>
            Ophis is an open-source interface to a permissionless on-chain DEX-aggregation protocol
            (CoW Protocol). The interface is provided <em>as-is</em>, without warranty of any kind,
            express or implied. You are solely responsible for your own private keys, signed orders,
            and any tokens you trade.
          </p>
          <p>
            Ophis is <strong>non-custodial</strong>: at no point does the interface, its operator,
            or any affiliated party take custody of your funds. Orders are signed locally by your
            wallet and broadcast to a network of competing solvers; settlement occurs on-chain via
            the GPv2 Settlement contract under Ophis&#39;s own allow-listed solver set on supported
            chains.
          </p>
          <p>
            By using Ophis you confirm that (a) you are not a resident of a jurisdiction in which
            cryptocurrency trading is prohibited, (b) you are not subject to OFAC or equivalent
            sanctions, and (c) you have read and accept the underlying CoW Protocol&#39;s on-chain
            terms.
          </p>
        </Section>

        <Section>
          <H2>Privacy Policy</H2>
          <p>
            Ophis does not collect personal identifying information (PII). Wallet addresses are
            pseudonymous public-blockchain identifiers and are necessarily transmitted to the
            interface during normal operation; they are not linked to any off-chain identity by us.
          </p>
          <p>
            We use <a href="https://sentry.io" target="_blank" rel="noreferrer">Sentry</a> for
            anonymized error and performance telemetry. No content of your trades, no addresses you
            type into the input form, and no wallet seeds are transmitted to Sentry. You can
            disable Sentry locally via browser settings; the application will continue to function.
          </p>
          <p>
            Cookies: we use first-party <code>localStorage</code> for SPA state (chain selection,
            recent tokens, intent-input history). No third-party advertising cookies are set by the
            interface.
          </p>
        </Section>

        <Section>
          <H2>Legal entity</H2>
          <Dl>
            <Dt>Operator</Dt>
            <Dd>COMMIT MEDIA S.à r.l.</Dd>
            <Dt>Legal form</Dt>
            <Dd>Société à responsabilité limitée (Luxembourg)</Dd>
            <Dt>Registered office</Dt>
            <Dd>147, Route de Thionville, L-2611 Luxembourg</Dd>
            <Dt>RCS Luxembourg</Dt>
            <Dd>B276192</Dd>
            <Dt>VAT (intra-EU)</Dt>
            <Dd>LU34811132</Dd>
            <Dt>Trade authorisation</Dt>
            <Dd>10150328 / 0</Dd>
            <Dt>NACE code</Dt>
            <Dd>70.210 — Activités des sièges sociaux et de conseil de gestion</Dd>
            <Dt>Legal representative</Dt>
            <Dd>Clément Fermaud, Gérant</Dd>
            <Dt>Contact</Dt>
            <Dd>
              <a href="mailto:clement@openletz.com">clement@openletz.com</a>
            </Dd>
          </Dl>
        </Section>

        <Section>
          <H2>Dispute resolution</H2>
          <p>
            These terms are governed by the laws of the Grand Duchy of Luxembourg. Any dispute
            arising from your use of the interface shall be submitted to the exclusive jurisdiction
            of the competent courts of the District of Luxembourg, without prejudice to any
            mandatory consumer-protection provisions of your jurisdiction of residence.
          </p>
        </Section>

        <Last>Last updated: 2026-05-22</Last>
      </Container>
    </Page>
  )
}
