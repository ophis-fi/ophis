/**
 * About Ophis.
 *
 * Phase A3 rebuild (PR #248, 2026-05-23) - replaces the 2026-05-22
 * "vibe-coded" implementation with ds/ primitives + cow.fi-density
 * content. No local styled-components, no per-page Title/Lede/Section
 * definitions; only ophis/ds primitives.
 *
 * Sections (cf. cow.fi/cow-protocol for density reference):
 *   - What is Ophis (one-line + 2-paragraph framing)
 *   - How it works (3-step FeatureGrid: Intent → Auction → Settle)
 *   - Why intent-based (rationale; contrast with traditional DEX UX)
 *   - Non-custodial guarantees (settlement contract, signing flow)
 *   - MEV protection (batch auctions, uniform clearing price)
 *   - Cross-chain via NEAR Intents (Solana + Bitcoin destinations)
 *   - Audited infrastructure (audit artifacts, claim badges)
 *   - Open source (license, GitHub, audit trail)
 *   - Who operates Ophis (non-custodial; formal operator disclosure on the Legal page)
 *   - FAQ (Accordion; deep-links to /docs#faq for full set)
 */
import { ReactNode } from 'react'

import { BRIDGE_ONLY_DESTINATION_LABELS_TEXT } from '@cowprotocol/common-const'

import {
  Accordion,
  AccordionGroup,
  Badge,
  Callout,
  FeatureCard,
  FeatureGrid,
  InlineCode,
  PageShell,
  Section,
  TextLink,
} from 'ophis/ds'

// eslint-disable-next-line max-lines-per-function -- static content page; single ds/ composition with no logic to extract
export default function AboutPage(): ReactNode {
  return (
    <PageShell
      width="medium"
      eyebrow="About Ophis"
      title="From order to settled trade."
      lede="Pick your tokens, review the route and minimum receive amount, and authorize the trade with your wallet."
    >
      <Section id="what" title="What is Ophis">
        <p>
          Ophis is an intent-based DEX aggregator built on{' '}
          <TextLink href="https://cow.fi" external>
            CoW Protocol
          </TextLink>
          . You build the order in a structured swap form - tokens, chain, and amount - review exactly what will be
          signed, and sign with your own wallet.
        </p>
        <p>
          The swap app supports 14 EVM networks. Ophis operates the orderbook and routing lanes on Optimism, Unichain,
          Robinhood Chain, and Arc; the other ten networks use CoW-hosted orderbooks. Batch-auction swaps settle through
          CoW Protocol&#39;s <InlineCode>GPv2Settlement</InlineCode> stack or Ophis deployments derived from it. Bridge,
          conversion, and OTC routes have separate execution and recovery rules.
        </p>
      </Section>

      <Section id="how" title="How it works" intro="Three steps for a standard batch-auction swap.">
        <FeatureGrid minCardWidth="280px">
          <FeatureCard icon="01" title="Intent">
            You build the order in the swap form: sell token, buy token, amount, and chain. Developers can also parse
            natural-language requests through the public Intent API.
          </FeatureCard>
          <FeatureCard icon="02" title="Auction">
            Solvers compete to fill your signed order using available liquidity or peer-to-peer matches. Routing lanes
            and participation depend on the network, token pair, and current availability.
          </FeatureCard>
          <FeatureCard icon="03" title="Settle">
            A solver settles within your signed limits. Uniform clearing prices per token pair and offchain order
            submission mitigate common MEV, but do not eliminate every execution risk.
          </FeatureCard>
        </FeatureGrid>
      </Section>

      <Section id="why" title="Why intent-based">
        <p>
          A directly submitted swap can face slippage and front-running while its transaction waits in the mempool. For
          a standard ERC-20 swap, Ophis lets you sign an order offchain describing what you want and the limits you
          accept. Solvers compete to fill it in a batch auction. Review the quote, approvals, and wallet signing request
          before authorizing any route.
        </p>
        <p>
          The order schema, the routing layer, and the settlement flow are transparent and auditable in the public
          repository. Developers building on Ophis can parse natural-language requests through the public Intent API -
          see <TextLink href="https://docs.ophis.fi/">the docs</TextLink>.
        </p>
      </Section>

      <Section id="non-custodial" title="Non-custodial by design">
        <Callout tone="success" title="Your keys, your tokens">
          Standard signed ERC-20 orders keep funds in your wallet until settlement. The settlement contract enforces the
          signed sell amount, receiver, and limit price. Solver authorization depends on the network&#39;s deployment.
        </Callout>
        <p>
          Native-token orders can require an onchain deposit; bridges can deposit or burn assets before delivery; OTC
          uses separate escrow. Their custody, gas, expiry, and recovery rules differ from standard ERC-20 orders. Check
          the contract and permissions requested by your wallet.
        </p>
      </Section>

      <Section id="mev" title="MEV protection">
        <p>
          Batch-auction swaps use a <strong>uniform clearing price per token pair</strong> and offchain order submission
          to mitigate common front-running and sandwich attacks. Settlement transactions can still be visible in the
          public mempool. Signed limits remain enforced, but this is not an absolute MEV guarantee and does not extend
          to every bridge, conversion, or OTC route.
        </p>
        <p>
          For the full mechanism description, see CoW Protocol&#39;s{' '}
          <TextLink href="https://docs.cow.fi/cow-protocol/concepts" external>
            protocol concepts docs
          </TextLink>
          .
        </p>
      </Section>

      <Section
        id="cross-chain"
        title="Cross-chain routes"
        intro={`Receive on Solana, Bitcoin, ${BRIDGE_ONLY_DESTINATION_LABELS_TEXT} through supported NEAR Intents routes.`}
      >
        <p>
          NEAR Intents availability depends on the source network, asset, and provider. An EVM network in the swap
          selector is not automatically a supported bridge source. Circle and Across serve separate routes; direct
          Circle bridging is not a batch-auction swap. Source settlement does not prove destination delivery.
        </p>
        <Callout tone="info" title="Destination-only today">
          Solana, Bitcoin, {BRIDGE_ONLY_DESTINATION_LABELS_TEXT} can be receive addresses but not source chains. Ophis
          uses an EVM wallet for these routes. Review destination-address requirements, gas, and provider recovery rules
          in the <TextLink href="https://docs.ophis.fi/networks-assets">networks and bridges guide</TextLink>.
        </Callout>
      </Section>

      <Section id="audits" title="Security reviews">
        <p>
          Ophis builds on CoW Protocol&#39;s GPv2 contracts, whose upstream audit reports include work by{' '}
          <TextLink href="https://github.com/cowprotocol/contracts" external>
            G0 Group and Hacken
          </TextLink>
          . Upstream audits apply to their stated scope, not every Ophis modification, deployment, or external route.
          Ophis-specific internal and tool-assisted reviews are documented in the{' '}
          <TextLink href="https://docs.ophis.fi/audits">security guide and linked reports</TextLink>.
        </p>
        <FeatureGrid minCardWidth="200px" gap="12px">
          <FeatureCard title="GPv2 upstream">
            Upstream reports cover the reviewed CoW contracts. They are not an audit of every Ophis deployment.{' '}
            <Badge tone="audit">Upstream scope</Badge>
          </FeatureCard>
          <FeatureCard title="Slither">
            Static-analysis results apply only to the contract versions and checks named in each report.{' '}
            <Badge tone="audit">Scoped analysis</Badge>
          </FeatureCard>
          <FeatureCard title="Codex Cyber">
            Tool-assisted reviews of selected backend and contract changes, not a blanket security certification.{' '}
            <Badge tone="audit">Scoped review</Badge>
          </FeatureCard>
          <FeatureCard title="Sharp-edges">
            Adversarial-pattern guidance informs internal reviews. Using a firm&#39;s skills or tools is not an audit or
            endorsement by that firm. <Badge tone="audit">Review guidance</Badge>
          </FeatureCard>
        </FeatureGrid>
      </Section>

      <Section id="open-source" title="Open source">
        <p>
          Ophis is open source under the GNU LGPL v3.0 (frontend) and CoW Protocol&#39;s upstream licenses (smart
          contracts, backend services). Code, deployment artefacts, and audit reports are public.
        </p>
        <p>
          <TextLink href="https://github.com/ophis-fi/ophis" external>
            View the code on GitHub
          </TextLink>
          {' · '}
          <TextLink href="https://docs.ophis.fi/">Read the docs</TextLink>
        </p>
      </Section>

      <Section id="operator" title="Who operates Ophis">
        <p>
          The Ophis interface is non-custodial and operated independently. The formal operator disclosure, including
          jurisdiction and entity details available on request for formal contractual or regulatory matters, lives in
          the operator section of the <TextLink href="/legal#operator">Legal page</TextLink>. Reach the team via the{' '}
          <TextLink href="/contact">contact form</TextLink>.
        </p>
      </Section>

      <Section id="faq" title="Common questions" intro="Selected highlights. Full FAQ in the docs.">
        <AccordionGroup>
          <Accordion summary="Do I need to connect a wallet?">
            <p>
              Yes, you authorize the order or transaction with your own wallet. Standard signed ERC-20 orders keep funds
              in your wallet until settlement; native-token, bridge, and escrow routes can move funds earlier.
            </p>
          </Accordion>
          <Accordion summary="What happens if no solver matches my intent?">
            <p>
              An unfilled standard ERC-20 order expires after its validity window, defaulting to 30 minutes, leaving
              unsold funds in your wallet. Native-token deposits require an onchain refund; bridges follow provider
              recovery rules. Soft cancellation can race an in-flight settlement.
            </p>
          </Accordion>
          <Accordion summary="Do I pay gas to place an order?">
            <p>
              ERC-20 order signing and offchain cancellation do not require a network transaction. Approvals,
              native-token deposits, onchain cancellation, bridges, and recovery can require gas. Solver settlement
              costs are reflected in the quote, not waived.
            </p>
          </Accordion>
          <Accordion summary="Can I use Ophis from my own app?">
            <p>
              Yes. The natural-language intent parser is publicly available at <InlineCode>POST /api/intent</InlineCode>{' '}
              with a 30 req/min/IP rate limit. No auth, no key. The published SDK and parser cover 13 EVM networks; Arc
              is currently app-only. See <TextLink href="https://docs.ophis.fi/">the docs</TextLink> for the full
              reference.
            </p>
          </Accordion>
        </AccordionGroup>
        <p>
          <TextLink href="https://docs.ophis.fi/faq" external>
            All FAQs in the docs →
          </TextLink>
        </p>
      </Section>
    </PageShell>
  )
}
