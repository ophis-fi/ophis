/**
 * Legal: Terms of Service + Privacy Policy + Cookies + Operator
 * disclosure + Dispute resolution.
 *
 * Finalized 2026-06-14. Replaces the earlier "pending counsel" draft.
 * Grounding (Luxembourg + EU):
 *   - Privacy: GDPR (Reg. (EU) 2016/679) + ePrivacy (Dir. 2002/58/EC).
 *   - Operator disclosure: e-commerce Dir. 2000/31/EC art. 5, transposed by
 *     the Luxembourg law of 14 August 2000 on electronic commerce.
 *   - Not-a-financial-service framing: MiCA (Reg. (EU) 2023/1114).
 *   - Governing law: Luxembourg law + courts of the District of Luxembourg,
 *     subject to mandatory EU consumer-protection carve-outs.
 *
 * Operator entity is identified by its regulatory facts only (legal name,
 * form, registered office, RCS number, contact channel). Nothing here
 * describes the entity's business, and no personal data of its officers is
 * published.
 */
import { ReactNode, useEffect } from 'react'

import { useLocation } from 'react-router'

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
  // HashRouter URLs look like /#/legal#privacy, so a "Privacy" deep-link lands here
  // with location.hash = '#privacy', but the browser never scrolls (the fragment is
  // inside the router hash, not a real document anchor). Scroll to the target section
  // id ourselves, on mount and whenever the hash changes.
  const { hash } = useLocation()
  useEffect(() => {
    if (!hash) return
    const el = document.getElementById(hash.slice(1))
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [hash])

  return (
    <PageShell
      width="medium"
      eyebrow="Legal"
      title="Terms, Privacy & Disclosures"
      lede="Effective and last updated 14 June 2026. Plain-language summaries sit above the legal language where helpful; the operator is identified in section 8 and governing law is in section 9."
    >
      <Callout tone="info" title="How to read this page">
        Each section opens with a plain-language summary in a colored box. Those summaries are for
        convenience only and have no legal effect; the operative terms are the paragraph text
        outside the boxes, and they govern if the two differ. Nothing on this page is legal, tax,
        or financial advice, and using Ophis is not a recommendation to trade.
      </Callout>

      {/* ─────────────────────────────────────────────────────────── */}

      <Section id="acceptance" title="1. Acceptance">
        <Callout tone="info">
          <strong>In short:</strong> by using the Ophis interface, you accept these terms.
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

      <Section id="non-custodial" title="3. Software, not a financial service">
        <Callout tone="success" title="In short">
          Ophis is a software interface. It never holds your funds: your wallet signs orders and
          the blockchain executes them. The operator cannot move your tokens, freeze your account,
          or recover lost keys, and does not provide financial services or act as your counterparty.
        </Callout>
        <p>
          The Service is a non-custodial frontend (a software tool) to permissionless on-chain
          DEX-aggregation protocols (principally CoW Protocol). Orders are signed locally by your
          wallet and broadcast off-chain to a network of competing solvers; settlement occurs
          on-chain via the GPv2 Settlement contract under an allow-listed solver set Ophis maintains
          on supported chains.
        </p>
        <p>
          The operator (see section 8) does <strong>not</strong> take custody of your funds at any
          point, does not execute trades on your behalf, and is not a counterparty to your
          transactions. It cannot reverse transactions, recover lost private keys, or freeze
          accounts.
        </p>
        <p>
          The operator provides software only. It does <strong>not</strong> provide investment,
          brokerage, dealing, portfolio-management, custody, exchange, transfer, payment, or
          electronic-money services, and is not authorised or registered as a regulated financial
          entity (including as a crypto-asset service provider under Regulation (EU) 2023/1114
          (MiCA)). See the FAQ below.
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
        <Callout tone="warning" title="In short">
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
          To the maximum extent permitted by applicable law, the operator&#39;s aggregate
          liability arising from or relating to your use of the Service is limited to the total
          amount of Service fees you paid through the Service during the twelve (12) months
          immediately preceding the event giving rise to the claim.
        </p>
        <p>
          Nothing in these Terms excludes or limits any liability that cannot be excluded or
          limited under applicable Luxembourg or European Union law, including mandatory
          consumer-protection provisions of an EU consumer&#39;s country of residence and liability
          for gross negligence, wilful misconduct, or death or personal injury caused by
          negligence.{' '}
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
        <Callout tone="success" title="In short">
          Ophis does not intentionally collect account-registration data, identity documents, or
          KYC. Your wallet address is pseudonymous; we don&#39;t link it to off-chain identity.
          We use Sentry for anonymized error telemetry and Google Analytics 4 for aggregate usage
          analytics that is consent-governed: off by default in the EEA, UK, and Switzerland until
          you opt in, on by default elsewhere. No advertising cookies. Note that pseudonymous data
          + IP addresses may still qualify as personal data under GDPR.
        </Callout>

        <h3>7.1. Data controller</h3>
        <p>
          For any personal data processed through the Service, the controller within the meaning
          of the EU General Data Protection Regulation (Regulation (EU) 2016/679,{' '}
          <strong>&quot;GDPR&quot;</strong>) is the operator identified in{' '}
          section 8 (Commit Media S.à r.l., Luxembourg). For any data-related request, email{' '}
          <TextLink href="mailto:contact@ophis.fi">contact@ophis.fi</TextLink> or use{' '}
          <TextLink href="/contact">the contact form</TextLink>.
        </p>

        <h3>7.2. What we collect, and the legal basis</h3>
        <p>
          The Service does not intentionally collect account-registration data, identity
          documents, or know-your-customer (KYC) information. Wallet addresses are pseudonymous
          public-blockchain identifiers and are transmitted during normal operation; the
          operator does not link them to off-chain identity. Under GDPR, pseudonymous identifiers
          and IP addresses may still qualify as personal data when linkable to a natural person.
          Where the operator processes such data, the legal basis is its legitimate interest
          (GDPR art. 6(1)(f)) in operating, securing, and improving the Service, and, where
          applicable, the necessity of processing to provide the Service you request.
        </p>

        <h3>7.3. Telemetry (Sentry)</h3>
        <p>
          The Service uses{' '}
          <TextLink href="https://sentry.io" external>
            Sentry
          </TextLink>{' '}
          for anonymized error and performance telemetry. No content of your trades, no
          addresses you type into the intent input form, and no wallet seeds are transmitted.
          Sentry can be blocked locally via browser settings; the Service continues to function.
        </p>

        <h3>7.4. Cookies, local storage, and analytics</h3>
        <p>
          The Service uses first-party <InlineCode>localStorage</InlineCode> for strictly
          necessary single-page-app state (chain selection, recent tokens, intent-input history,
          wallet connection state, and your analytics-consent choice). Under the ePrivacy Directive
          (2002/58/EC), strictly necessary storage does not require prior consent.
        </p>
        <p>
          The Service also uses Google Analytics 4 (Google Ireland Ltd.) for aggregate usage
          analytics, loaded first-party from <InlineCode>swap.ophis.fi</InlineCode>. Analytics
          storage is governed by Google Consent Mode v2 and is region-scoped: it is denied by
          default for visitors in the EEA, the United Kingdom, and Switzerland (the Service runs
          cookieless there until you opt in via the on-page consent banner) and granted by default
          elsewhere. Your choice is stored in first-party <InlineCode>localStorage</InlineCode>{' '}
          under the key <InlineCode>ophis_consent</InlineCode> and can be changed at any time. No
          advertising cookies are set, and no cross-site advertising tracking is performed.
        </p>

        <h3>7.5. Third-party services</h3>
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
            <strong>Google Analytics 4</strong> (Google Ireland Ltd., aggregate usage analytics,
            consent-governed and region-scoped as described in 7.4).{' '}
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

        <h3>7.6. Your rights (GDPR)</h3>
        <p>
          If you are in the European Economic Area, you have the right to access, rectify, erase,
          restrict, port, or object to processing of personal data the operator holds about you
          (GDPR arts. 15 to 22). As stated above, the operator does not intentionally collect
          account-registration data or identity documents; however, pseudonymous wallet addresses
          and IP metadata at the CDN layer may qualify as personal data depending on linkability.
          To exercise a right, email{' '}
          <TextLink href="mailto:contact@ophis.fi">contact@ophis.fi</TextLink> or use{' '}
          <TextLink href="/contact">the contact form</TextLink> with enough detail to identify
          the data in question. You also have the right to lodge a
          complaint with a supervisory authority, in Luxembourg the{' '}
          <TextLink href="https://cnpd.public.lu" external>
            Commission nationale pour la protection des données (CNPD)
          </TextLink>
          . For Sentry telemetry deletion, you may also contact Sentry directly under its policy.
        </p>
      </Section>

      {/* ─────────────────────────────────────────────────────────── */}

      <Section id="operator" title="8. Operator (legal entity)">
        <Callout tone="info">
          The Service is provided by Commit Media S.à r.l., a private limited-liability company
          governed by the laws of the Grand Duchy of Luxembourg. The operator is identified below;
          its registered office is on record in the Luxembourg trade register (RCS) under the
          number shown.
        </Callout>
        <KeyValueList
          items={[
            { label: 'Operator', value: 'Commit Media S.à r.l.' },
            {
              label: 'Legal form',
              value: 'Société à responsabilité limitée (private limited-liability company)',
            },
            {
              label: 'Trade register',
              value: 'Luxembourg Business Registers (RCS Luxembourg), no. B276192',
            },
            {
              label: 'Contact',
              value: (
                <>
                  <TextLink href="mailto:contact@ophis.fi">contact@ophis.fi</TextLink> or via{' '}
                  <TextLink href="/contact">the contact form</TextLink> (general, legal, and
                  data-protection matters).
                </>
              ),
            },
          ]}
        />
        <p>
          The operator is not a financial institution and does not provide regulated financial
          services; it makes the Service software available as described in section 3.
        </p>
      </Section>

      {/* ─────────────────────────────────────────────────────────── */}

      <Section id="dispute-resolution" title="9. Governing law + dispute resolution">
        <p>
          These Terms are governed by the laws of the Grand Duchy of Luxembourg. Any dispute
          arising from or relating to your use of the Service shall be submitted to the exclusive
          jurisdiction of the competent courts of the District of Luxembourg, without prejudice to
          any mandatory consumer-protection provisions and jurisdiction rules that apply to an EU
          consumer in their country of residence.{' '}
        </p>
      </Section>

      {/* ─────────────────────────────────────────────────────────── */}

      <Section id="changes" title="10. Changes to these terms">
        <p>
          The operator may revise these Terms at any time. Material changes will be reflected in
          the <InlineCode>Effective and last updated</InlineCode> date at the top of this page.
          Continued use of the Service after a revision constitutes acceptance of the revised
          Terms.
        </p>
      </Section>

      {/* ─────────────────────────────────────────────────────────── */}

      <Section id="faq" title="Common legal questions">
        <AccordionGroup>
          <Accordion summary="Is Ophis a regulated financial-services entity?">
            <p>
              No. The operator, Commit Media S.à r.l., makes available a non-custodial software
              interface to permissionless on-chain protocols. It does not provide investment,
              brokerage, dealing, custody, exchange, transfer, payment, or electronic-money
              services, and it is not authorised or registered as an investment firm, payment
              institution, electronic-money institution, or crypto-asset service provider (CASP)
              under Regulation (EU) 2023/1114 (MiCA) or any equivalent regime. Using Ophis is not
              the provision of a financial service to you.
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
              The operator cannot help. Ophis is non-custodial, your private keys, your tokens.
              We have no recovery mechanism, no support process for lost keys, and no ability to
              freeze or move funds from any wallet.
            </p>
          </Accordion>
          <Accordion summary="Can I request deletion of my data under GDPR?">
            <p>
              The operator does not collect identity documents or account-registration data and
              generally holds no directly identifying information about Service users. Where you
              believe the operator holds personal data about you, you may exercise your GDPR
              rights via <TextLink href="/contact">the contact form</TextLink>, and you may lodge
              a complaint with the Luxembourg CNPD. For Sentry telemetry deletion, contact Sentry
              directly under its own privacy policy.
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
