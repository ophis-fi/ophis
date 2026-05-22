/**
 * Ophis About page — mission, non-custodial guarantee, open-source
 * disclosure, operator identity.
 *
 * Static single-page document. Created in PR #234 closing Clement's
 * 2026-05-22 brand task #8 (Missing About page).
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
  width: min(720px, 100%);
  margin: 0 auto;
  padding: 64px 24px 96px;
  line-height: 1.7;
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
  margin-top: 36px;
`

const H2 = styled.h2`
  font-family: 'Fraunces', var(--cow-font-family-primary, system-ui);
  font-weight: 500;
  font-size: 22px;
  margin: 0 0 10px;
  color: #f5efe6;
`

const A = styled.a`
  color: #f2a63e;
  text-decoration: none;
  border-bottom: 1px solid rgba(242, 166, 62, 0.4);
  &:hover {
    border-bottom-color: #f2a63e;
  }
`

export default function AboutPage(): ReactNode {
  return (
    <Page>
      <OphisHeader />
      <Container>
        <Title>About Ophis</Title>
        <Lede>Tell us what to trade. We pre-fill the form. You sign.</Lede>

        <Section>
          <H2>What Ophis is</H2>
          <p>
            Ophis is an intent-based DEX aggregator built on{' '}
            <A href="https://cow.fi" target="_blank" rel="noreferrer">
              CoW Protocol
            </A>
            . You describe what you want to trade in plain English; we parse the tokens, chain, and
            amount, then pre-fill a swap form that you sign with your own wallet.
          </p>
        </Section>

        <Section>
          <H2>Why intent-based</H2>
          <p>
            A traditional DEX form asks you to fill four fields, validate two token addresses, and
            understand which network you&#39;re on before you can start trading. Ophis flips that:
            type the trade as a sentence, our parser translates it into protocol primitives, and the
            interface shows you exactly what will be signed before any transaction leaves your
            wallet.
          </p>
        </Section>

        <Section>
          <H2>Non-custodial by design</H2>
          <p>
            Your tokens never leave your wallet until on-chain settlement. Orders are signed
            locally, broadcast off-chain to a network of competing solvers, and settled through the
            audited GPv2 Settlement contract under Ophis&#39;s own allow-listed solver set. Ophis
            cannot move your tokens; only the protocol can, and only against an order you signed.
          </p>
        </Section>

        <Section>
          <H2>MEV-protected</H2>
          <p>
            Every order is settled inside a batch auction at a uniform clearing price. Front-running
            and sandwich attacks are eliminated by construction — the protocol does not reorder
            transactions for value, so there is no priority-gas-auction to win against you.
          </p>
        </Section>

        <Section>
          <H2>Cross-chain via NEAR Intents</H2>
          <p>
            Trade from any EVM chain to <strong>Solana</strong> or <strong>Bitcoin</strong>{' '}
            without a second wallet. NEAR Intents brokers the bridge step off-chain: you sign with
            your EVM wallet, paste a destination address (base58 for Solana, native for Bitcoin),
            and the solver network handles the rest. Currently destination-only — Solana and
            Bitcoin can be receive addresses but not source chains, since Ophis runs on EVM
            wallet infrastructure.
          </p>
        </Section>

        <Section>
          <H2>Open source</H2>
          <p>
            Ophis is open source under the GNU LGPL v3.0 (frontend) and CoW Protocol&#39;s upstream
            licenses (smart contracts, backend services).{' '}
            <A href="https://github.com/ophis-fi/ophis" target="_blank" rel="noreferrer">
              View the code on GitHub
            </A>
            . Independent audits and the live deployment artefacts are linked from the{' '}
            <A href="/docs">docs</A>.
          </p>
        </Section>

        <Section>
          <H2>Who operates Ophis</H2>
          <p>
            The interface at <code>ophis.fi</code> is operated by{' '}
            <strong>COMMIT MEDIA S.à r.l.</strong>, a Luxembourg consultancy company (RCS
            B276192). Full legal-entity disclosure is on the <A href="/legal">Legal</A> page.
          </p>
        </Section>
      </Container>
      <OphisFooter />
    </Page>
  )
}
