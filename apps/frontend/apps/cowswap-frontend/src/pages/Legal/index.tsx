/**
 * Legal — Terms of Service + Privacy Policy + Cookies + Legal Entity
 * + Dispute Resolution.
 *
 * Phase A3 rebuild (PR #249, 2026-05-23). Replaces the 2026-05-22
 * vibe-coded implementation. Uses ONLY ds/ primitives.
 *
 * Important framing per the Codex 2026-05-23 design review:
 *   - Legal pages have a higher evidentiary bar than About.
 *   - Each section labels claims as live / draft where applicable.
 *   - Operator facts are separated from product claims via KeyValueList.
 *   - Plain-English summaries precede legal text inside Callouts so the
 *     reader can scan the page without reading every clause.
 *
 * This page is NOT a substitute for lawyer-reviewed terms. Sections
 * marked Badge tone='draft' are placeholders that need legal review
 * before any volume routes through ophis.fi in jurisdictions with
 * consumer-protection enforcement (EU, UK). The Commit Media legal
 * entity disclosure IS live and factually correct (from RCS B276192).
 */
import { ReactNode } from 'react'

import {
  Accordion,
  AccordionGroup,
  Badge,
  Callout,
  InlineCode,
  KeyValueList,
  PageShell,
  Section,
  TextLink,
} from 'ophis/ds'

export default function LegalPage(): ReactNode {
  return (
    <PageShell
      width="medium"
      eyebrow="Legal"
      title="Terms, Privacy & Disclosures"
      lede="Plain-English summaries above the legal language where helpful. Reviewed against Luxembourg consumer-protection guidelines; see § Dispute resolution for jurisdiction."
    >
      <Callout tone="planned" title="Draft notice">
        Sections marked <Badge tone="draft">draft</Badge> are placeholder language pending review
        by a qualified Luxembourg legal counsel. The legal-entity disclosure (§ Operator) is
        live and factually correct. Last updated <InlineCode>2026-05-23</InlineCode>.
      </Callout>

      {/* ─────────────────────────────────────────────────────────── */}

      <Section id="acceptance" title="1. Acceptance">
        <Callout tone="info">
          <strong>Plain English:</strong> by using the Ophis interface, you accept these terms.
          If you don&#39;t accept them, don&#39;t connect a wallet and don&#39;t sign orders.
        </Callout>
        <p>
          By accessing <InlineCode>ophis.fi</InlineCode>, connecting a wallet, signing an order,
          or otherwise using the interface (collectively, <strong>&quot;the Service&quot;</strong>),
          you agree to be bound by these Terms of Service (<strong>&quot;Terms&quot;</strong>) and
          the Privacy Policy below.{' '}
          <Badge tone="draft">draft</Badge>
        </p>
      </Section>

      {/* ─────────────────────────────────────────────────────────── */}

      <Section id="eligibility" title="2. Eligibility">
        <Callout tone="warning" title="Sanctions + restricted jurisdictions">
          You confirm you are NOT a resident of, or accessing from, a jurisdiction where
          cryptocurrency trading is prohibited; AND you are NOT subject to OFAC, EU, UK, or
          equivalent international sanctions.
        </Callout>
        <p>
          You confirm you have the legal capacity to enter into binding contracts under your
          jurisdiction. Use by minors is prohibited.{' '}
          <Badge tone="draft">draft</Badge>
        </p>
      </Section>

      {/* ─────────────────────────────────────────────────────────── */}

      <Section id="non-custodial" title="3. Non-custodial nature of the Service">
        <Callout tone="success" title="Plain English">
          Ophis never holds your funds. Your wallet signs orders; the blockchain executes them.
          We cannot move your tokens, freeze your account, or recover lost keys.
        </Callout>
        <p>
          The Service is a frontend interface to permissionless on-chain DEX-aggregation
          protocols (principally CoW Protocol). Orders are signed locally by your wallet and
          broadcast off-chain to a network of competing solvers; settlement occurs on-chain via
          the GPv2 Settlement contract under an allow-listed solver set Ophis maintains on
          supported chains.
        </p>
        <p>
          The operator of the Service (see § Operator) does <strong>not</strong> take custody of
          your funds at any point. The operator cannot reverse transactions, recover lost private
          keys, or freeze accounts.
        </p>
      </Section>

      {/* ─────────────────────────────────────────────────────────── */}

      <Section id="prohibited-use" title="4. Prohibited use">
        <p>You agree not to use the Service to:</p>
        <ul>
          <li>Engage in market manipulation, wash trading, or fraudulent activity.</li>
          <li>Route proceeds of crime, sanctioned funds, or otherwise launder value.</li>
          <li>
            Attempt to bypass the partner-fee mechanism, the solver allowlist, or any other
            integrity control on the Service.
          </li>
          <li>
            Probe, scan, or otherwise attempt to exploit the Service&#39;s infrastructure outside
            of a documented responsible-disclosure process (see <InlineCode>SECURITY.md</InlineCode>{' '}
            in the public repository).
          </li>
          <li>
            Use the natural-language intent API at <InlineCode>POST /api/intent</InlineCode>{' '}
            beyond the public rate limit (30 requests/min/IP) without prior written consent from
            the operator.
          </li>
        </ul>
        <Badge tone="draft">draft</Badge>
      </Section>

      {/* ─────────────────────────────────────────────────────────── */}

      <Section id="disclaimers" title="5. Disclaimers + limitation of liability">
        <Callout tone="warning" title="Plain English">
          The Service is provided <em>as-is</em>. Trading is risky. You can lose money. Ophis
          and its operator are not liable for losses arising from your use of the Service, the
          blockchain, or any solver / liquidity venue Ophis routes through.
        </Callout>
        <p>
          THE SERVICE IS PROVIDED <strong>&quot;AS-IS&quot;</strong> AND <strong>&quot;AS-AVAILABLE&quot;</strong>,
          WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED. THE OPERATOR DISCLAIMS ALL WARRANTIES
          OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, NON-INFRINGEMENT, AND ACCURACY OF
          DATA, TO THE FULLEST EXTENT PERMITTED BY APPLICABLE LAW.
        </p>
        <p>
          To the maximum extent permitted by applicable law (including consumer-protection
          provisions of your jurisdiction of residence), the operator&#39;s aggregate liability
          arising from your use of the Service is limited to the partner fees the operator has
          received from your trades in the trailing twelve (12) months, or EUR 100, whichever is
          greater.{' '}
          <Badge tone="draft">draft — pending legal review</Badge>
        </p>
      </Section>

      {/* ─────────────────────────────────────────────────────────── */}

      <Section id="protocol-risks" title="6. Protocol-layer risks">
        <Callout tone="info">
          The blockchain protocols Ophis routes through (CoW Protocol GPv2, NEAR Intents, etc.)
          are NOT under the operator&#39;s control. The operator accepts no responsibility for
          their behaviour, bugs, or downtime.
        </Callout>
        <p>
          By using the Service you accept that:
        </p>
        <ul>
          <li>
            Smart-contract bugs in the underlying protocols can result in total loss of funds.
            The operator publishes audit references (see <TextLink href="/about#audits">/about</TextLink>)
            but does NOT warrant the underlying contracts.
          </li>
          <li>
            Cross-chain bridge transactions (e.g. via NEAR Intents to Solana/Bitcoin) involve a
            third-party bridge layer with its own risk profile. The operator does not control the
            bridge.
          </li>
          <li>
            Network congestion, RPC outages, or wallet provider issues can cause failed or
            partial settlement.
          </li>
        </ul>
      </Section>

      {/* ─────────────────────────────────────────────────────────── */}

      <Section id="privacy" title="7. Privacy Policy">
        <Callout tone="success" title="Plain English">
          Ophis does not collect personal identifying information. Your wallet address is
          pseudonymous and necessarily transmitted; we don&#39;t link it to off-chain identity.
          We use Sentry for anonymized error telemetry. No advertising cookies.
        </Callout>

        <h3>7.1 — What we collect</h3>
        <p>
          The Service does not collect personal identifying information (PII). Wallet addresses
          are pseudonymous public-blockchain identifiers and are transmitted during normal
          operation; they are not linked to off-chain identity by the operator.
        </p>

        <h3>7.2 — Telemetry (Sentry)</h3>
        <p>
          The Service uses{' '}
          <TextLink href="https://sentry.io" external>
            Sentry
          </TextLink>{' '}
          for anonymized error and performance telemetry. No content of your trades, no
          addresses you type into the intent input form, and no wallet seeds are transmitted.
          Sentry can be blocked locally via browser settings; the Service continues to function.
        </p>

        <h3>7.3 — Cookies + localStorage</h3>
        <p>
          The Service uses first-party <InlineCode>localStorage</InlineCode> for SPA state (chain
          selection, recent tokens, intent-input history, wallet connection state). No
          third-party advertising cookies are set. No first-party tracking cookies are set.
        </p>

        <h3>7.4 — Third-party services</h3>
        <p>
          The Service relies on the following third parties; each has its own privacy policy:
        </p>
        <ul>
          <li>
            <strong>Cloudflare Pages</strong> (hosting + CDN) —{' '}
            <TextLink href="https://www.cloudflare.com/privacypolicy/" external>
              policy
            </TextLink>
          </li>
          <li>
            <strong>Sentry</strong> (error telemetry) —{' '}
            <TextLink href="https://sentry.io/privacy/" external>
              policy
            </TextLink>
          </li>
          <li>
            <strong>LibertAI</strong> (natural-language parsing endpoint) —{' '}
            <TextLink href="https://libertai.io" external>
              libertai.io
            </TextLink>
          </li>
          <li>
            <strong>NEAR Intents</strong> (cross-chain bridge layer for Solana / Bitcoin
            destinations).
          </li>
        </ul>

        <h3>7.5 — Your rights (GDPR, if applicable)</h3>
        <p>
          If you are a resident of the European Economic Area, you have the right to access,
          rectify, or delete personal data we hold about you. As stated above, the Service does
          not collect PII; the operator has no PII to access, rectify, or delete in connection
          with your use of the interface. For Sentry telemetry deletion, contact Sentry
          directly per its policy.
        </p>
      </Section>

      {/* ─────────────────────────────────────────────────────────── */}

      <Section id="operator" title="8. Operator (legal entity)">
        <Callout tone="info">
          <strong>This section is live and factually accurate.</strong> Operator legal-entity
          details are publicly registered at the Luxembourg Business Registers (RCS B276192).
        </Callout>
        <KeyValueList
          items={[
            { label: 'Operator', value: 'COMMIT MEDIA S.à r.l.' },
            { label: 'Legal form', value: 'Société à responsabilité limitée (Luxembourg)' },
            { label: 'Registered office', value: '147, Route de Thionville, L-2611 Luxembourg' },
            { label: 'RCS Luxembourg', value: <InlineCode>B276192</InlineCode> },
            { label: 'VAT (intra-EU)', value: <InlineCode>LU34811132</InlineCode> },
            { label: 'Trade authorisation', value: <InlineCode>10150328 / 0</InlineCode> },
            { label: 'NACE code', value: '70.210 — Activités des sièges sociaux et de conseil de gestion' },
            { label: 'Legal representative', value: 'Clément Fermaud, Gérant' },
            {
              label: 'Contact',
              value: <TextLink href="mailto:clement@openletz.com">clement@openletz.com</TextLink>,
            },
          ]}
        />
      </Section>

      {/* ─────────────────────────────────────────────────────────── */}

      <Section id="dispute-resolution" title="9. Governing law + dispute resolution">
        <p>
          These terms are governed by the laws of the Grand Duchy of Luxembourg. Any dispute
          arising from your use of the Service shall be submitted to the exclusive jurisdiction
          of the competent courts of the District of Luxembourg, without prejudice to any
          mandatory consumer-protection provisions of your jurisdiction of residence.{' '}
          <Badge tone="draft">draft</Badge>
        </p>
      </Section>

      {/* ─────────────────────────────────────────────────────────── */}

      <Section id="changes" title="10. Changes to these terms">
        <p>
          The operator may revise these Terms at any time. Material changes will be reflected via
          an updated <InlineCode>Last updated</InlineCode> date in the draft notice above. Continued
          use of the Service after a revision constitutes acceptance of the revised Terms.
        </p>
      </Section>

      {/* ─────────────────────────────────────────────────────────── */}

      <Section id="faq" title="Common legal questions">
        <AccordionGroup>
          <Accordion summary="Is Ophis a regulated financial-services entity?">
            <p>
              No. The operator (COMMIT MEDIA S.à r.l.) is a Luxembourg consultancy company
              providing a non-custodial software interface to permissionless on-chain protocols.
              The operator does NOT act as a broker, dealer, custodian, or money-service business.
            </p>
          </Accordion>
          <Accordion summary="Do you collect KYC?">
            <p>
              No. The Service does not collect KYC. Wallet addresses are pseudonymous and not
              linked to off-chain identity by the operator. Note that the underlying blockchain
              and any solver/bridge layer routing through it may have its own compliance posture
              outside of Ophis&#39;s control.
            </p>
          </Accordion>
          <Accordion summary="What happens if I lose access to my wallet?">
            <p>
              The operator cannot help. Ophis is non-custodial — your private keys, your tokens.
              We have no recovery mechanism, no support process for lost keys, and no ability to
              freeze or move funds from any wallet.
            </p>
          </Accordion>
          <Accordion summary="Can I request deletion of my data under GDPR?">
            <p>
              The operator does not collect personal identifying information from Service users
              and has no PII to delete. For Sentry telemetry deletion, contact Sentry directly
              under their own privacy policy.
            </p>
          </Accordion>
          <Accordion summary="How do I report a security issue?">
            <p>
              See the <InlineCode>SECURITY.md</InlineCode> file in the public repository at{' '}
              <TextLink href="https://github.com/ophis-fi/ophis/blob/main/SECURITY.md" external>
                github.com/ophis-fi/ophis
              </TextLink>{' '}
              for the responsible-disclosure process.
            </p>
          </Accordion>
        </AccordionGroup>
      </Section>
    </PageShell>
  )
}
