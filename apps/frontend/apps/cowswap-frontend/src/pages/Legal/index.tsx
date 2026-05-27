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
 * consumer-protection enforcement (EU, UK). The operator-entity
 * disclosure section (§ 8) is intentionally generic — specific
 * identifiers (legal name, registered office, RCS / VAT numbers,
 * trade authorisation, legal representative) are provided on request
 * for formal contractual / regulatory / dispute-resolution matters.
 */
import { ReactNode } from 'react'

import {
  Accordion,
  AccordionGroup,
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
      <Callout tone="info" title="Plain-English summaries, non-binding">
        Each section opens with a plain-English summary in a colored Callout box. These summaries
        are for convenience only and have no legal effect, the operative terms are the
        paragraph text outside the summary boxes.
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
          arising from your use of the Service is limited to a cap to be determined by qualified
          legal counsel.{' '}
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
          Ophis does not intentionally collect account-registration data, identity documents, or
          KYC. Your wallet address is pseudonymous; we don&#39;t link it to off-chain identity.
          We use Sentry for anonymized error telemetry. No advertising cookies. Note that
          pseudonymous data + IP addresses may still qualify as personal data under GDPR.
        </Callout>

        <h3>7.1. What we collect</h3>
        <p>
          The Service does not intentionally collect account-registration data, identity
          documents, or know-your-customer (KYC) information. Wallet addresses are pseudonymous
          public-blockchain identifiers and are transmitted during normal operation; the
          operator does not link them to off-chain identity. Note that under EU law (GDPR),
          pseudonymous identifiers and IP addresses may still qualify as personal data when
          linkable to a natural person.
        </p>

        <h3>7.2. Telemetry (Sentry)</h3>
        <p>
          The Service uses{' '}
          <TextLink href="https://sentry.io" external>
            Sentry
          </TextLink>{' '}
          for anonymized error and performance telemetry. No content of your trades, no
          addresses you type into the intent input form, and no wallet seeds are transmitted.
          Sentry can be blocked locally via browser settings; the Service continues to function.
        </p>

        <h3>7.3. Cookies + localStorage</h3>
        <p>
          The Service uses first-party <InlineCode>localStorage</InlineCode> for SPA state (chain
          selection, recent tokens, intent-input history, wallet connection state). No
          third-party advertising cookies are set. No first-party tracking cookies are set.
        </p>

        <h3>7.4. Third-party services</h3>
        <p>
          When you use the Service, your browser makes requests to the following third parties.
          Each has its own privacy policy. The operator has no special relationship with these
          services beyond standard API integration.
        </p>
        <ul>
          <li>
            <strong>Cloudflare</strong> (hosting + CDN + DNS), receives IP, user agent, request
            metadata.{' '}
            <TextLink href="https://www.cloudflare.com/privacypolicy/" external>
              policy
            </TextLink>
          </li>
          <li>
            <strong>Sentry</strong> (anonymized error + performance telemetry).{' '}
            <TextLink href="https://sentry.io/privacy/" external>
              policy
            </TextLink>
          </li>
          <li>
            <strong>Google Fonts</strong> (Fraunces, Plus Jakarta Sans, JetBrains Mono served from{' '}
            <InlineCode>fonts.googleapis.com</InlineCode> + <InlineCode>fonts.gstatic.com</InlineCode>).
            Receives IP + user agent on first page load.{' '}
            <TextLink href="https://policies.google.com/privacy" external>
              policy
            </TextLink>
          </li>
          <li>
            <strong>LibertAI</strong> (natural-language intent parsing endpoint).{' '}
            <TextLink href="https://libertai.io" external>
              libertai.io
            </TextLink>
          </li>
          <li>
            <strong>NEAR Intents</strong> (cross-chain bridge layer for Solana / Bitcoin
            destinations).{' '}
            <TextLink href="https://near-intents.org" external>
              near-intents.org
            </TextLink>
          </li>
          <li>
            <strong>Bungee Exchange + Across Protocol</strong> (cross-chain EVM bridge providers
            wired via <InlineCode>@cowprotocol/sdk-bridging</InlineCode>).
          </li>
          <li>
            <strong>CoW Protocol orderbook API</strong> (order submission, quote retrieval,
            settlement broadcast).{' '}
            <TextLink href="https://api.cow.fi" external>
              api.cow.fi
            </TextLink>
          </li>
          <li>
            <strong>Public RPC providers</strong> (Alchemy, PublicNode, Ankr, viem default
            endpoints), receive IP + RPC method call metadata for chain queries.
          </li>
        </ul>

        <h3>7.5. Your rights (GDPR, if applicable)</h3>
        <p>
          If you are a resident of the European Economic Area, you have the right to access,
          rectify, restrict, port, or object to processing of personal data the operator holds
          about you. As stated above, the operator does not intentionally collect account-
          registration data or identity documents; however, pseudonymous wallet addresses + IP
          metadata at the CDN layer may qualify as personal data depending on linkability. For
          requests, reach the operator via the contact channel on{' '}
          <TextLink href="/institutional#contact">/institutional</TextLink> with sufficient
          detail to identify the data in question. For Sentry telemetry deletion, contact
          Sentry directly per its policy.
        </p>
      </Section>

      {/* ─────────────────────────────────────────────────────────── */}

      <Section id="operator" title="8. Operator (legal entity)">
        <Callout tone="info">
          The Service is operated by a Luxembourg-incorporated consultancy company registered
          with the Luxembourg Business Registers (RCS). Full entity details, including the
          registered legal name, registered office, RCS / VAT numbers, trade authorisation
          reference, NACE classification, and legal representative, are provided on request
          for formal contractual, regulatory, or dispute-resolution matters.
        </Callout>
        <KeyValueList
          items={[
            { label: 'Jurisdiction', value: 'Grand Duchy of Luxembourg' },
            { label: 'Legal form', value: 'Limited-liability company (Société à responsabilité limitée)' },
            {
              label: 'Registry',
              value: 'Luxembourg Business Registers (RCS), entity number on request',
            },
            {
              label: 'Activity classification',
              value: 'Management consultancy / head-office activities',
            },
            {
              label: 'Entity details (full)',
              value: (
                <>
                  Available on request for formal arrangements, reach out via the contact
                  section on <TextLink href="/institutional#contact">/institutional</TextLink>.
                </>
              ),
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
        </p>
      </Section>

      {/* ─────────────────────────────────────────────────────────── */}

      <Section id="changes" title="10. Changes to these terms">
        <p>
          The operator may revise these Terms at any time. Material changes will be reflected via
          an updated <InlineCode>Last updated</InlineCode> date here. Continued
          use of the Service after a revision constitutes acceptance of the revised Terms.
        </p>
      </Section>

      {/* ─────────────────────────────────────────────────────────── */}

      <Section id="faq" title="Common legal questions">
        <AccordionGroup>
          <Accordion summary="Is Ophis a regulated financial-services entity?">
            <p>
              The operator is a Luxembourg-incorporated consultancy company providing
              a non-custodial software interface to permissionless on-chain protocols. As of the
              date of this page, the operator is not registered as a regulated investment
              firm, payment institution, e-money institution, virtual-asset service provider, or
              equivalent in Luxembourg or other EU jurisdictions. Whether the Service falls
              under any specific financial-services regime in a given jurisdiction is being
              reviewed by counsel.            </p>
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
              The operator cannot help. Ophis is non-custodial, your private keys, your tokens.
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
