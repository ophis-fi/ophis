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
      lede="Pick your tokens, review the quote, and sign. The trade settles in a batch auction with MEV protection by construction."
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
          Under the hood, every order is broadcast to a network of competing solvers who race to find the best path. The
          winning route settles on-chain through CoW Protocol&#39;s audited <InlineCode>GPv2Settlement</InlineCode>{' '}
          contract, at a uniform clearing price, inside a batch auction designed to prevent front-running and sandwich
          attacks.
        </p>
      </Section>

      <Section id="how" title="How it works" intro="Three steps from order to settlement.">
        <FeatureGrid minCardWidth="280px">
          <FeatureCard icon="01" title="Intent">
            You build the order in the swap form: sell token, buy token, amount, and chain. Developers can also parse
            natural-language requests through the public Intent API.
          </FeatureCard>
          <FeatureCard icon="02" title="Auction">
            The signed order is broadcast to the batch auction. Solvers race to find the best path. DEX, peer-to-peer
            match, or cross-chain bridge, and bid for the right to settle.
          </FeatureCard>
          <FeatureCard icon="03" title="Settle">
            The winning solver settles your order in a batch where every trade clears at the same uniform price. No
            front-running, no sandwich, no priority-gas auction.
          </FeatureCard>
        </FeatureGrid>
      </Section>

      <Section id="why" title="Why intent-based">
        <p>
          A traditional DEX executes the moment you transact, exposing you to slippage and front-running while the
          transaction sits in the mempool. Ophis is intent-based instead: you sign an order off-chain describing what
          you want, solvers compete to fill it, and settlement happens in a batch auction at a uniform clearing price.
          The interface shows you exactly what will be signed before anything leaves your wallet.
        </p>
        <p>
          The order schema, the routing layer, and the settlement flow are transparent and auditable in the public
          repository. Developers building on Ophis can parse natural-language requests through the public Intent API -
          see <TextLink href="https://docs.ophis.fi/">the docs</TextLink>.
        </p>
      </Section>

      <Section id="non-custodial" title="Non-custodial by design">
        <Callout tone="success" title="Your keys, your tokens">
          Ophis never holds your funds. Orders are signed locally by your wallet, broadcast off-chain to a network of
          competing solvers, and settled through the audited GPv2 Settlement contract under Ophis&#39;s own allow-listed
          solver set on supported chains.
        </Callout>
        <p>
          The protocol itself executes settlements; the Ophis interface only routes intents. Ophis cannot move your
          tokens, only the protocol can, and only against an order you signed.
        </p>
      </Section>

      <Section id="mev" title="MEV protection">
        <p>
          Every order is settled inside a <strong>batch auction at a uniform clearing price</strong>. The protocol does
          not reorder transactions for value, instead, every trade in a batch clears against the same price, which
          removes the typical priority-gas-auction race that enables front-running and sandwich attacks against ordinary
          users.
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
        title="Cross-chain via NEAR Intents"
        intro="Trade from any EVM chain to Solana or Bitcoin without a second wallet."
      >
        <p>
          NEAR Intents brokers the bridge step off-chain. You sign with your EVM wallet, paste a destination address
          (base58 for Solana, native format for Bitcoin), and the solver network handles the rest.
        </p>
        <Callout tone="info" title="Destination-only today">
          Solana and Bitcoin can be receive addresses but not source chains. Ophis runs on EVM wallet infrastructure
          (wagmi + WalletConnect / MetaMask / Safe / Coinbase). Native Solana / Bitcoin wallet connect is not on the
          roadmap.
        </Callout>
      </Section>

      <Section id="audits" title="Security reviews">
        <p>
          The settlement layer uses CoW Protocol&#39;s GPv2 contracts, which carry upstream audit coverage by{' '}
          <TextLink href="https://github.com/cowprotocol/contracts" external>
            G0 Group and Hacken
          </TextLink>{' '}
          from the CoW Protocol launch period. The Ophis-specific surface, solver wiring, partner-fee plumbing, the
          driver-level Custom-interaction allowlist, and the OP-mainnet AllowList contract upgrade, was reviewed in May
          2026 across multiple tooling passes. Findings are tracked in <InlineCode>docs/audits/</InlineCode>.
        </p>
        <FeatureGrid minCardWidth="200px" gap="12px">
          <FeatureCard title="GPv2 upstream">
            CoW Protocol&#39;s settlement contracts audited by G0 Group and Hacken on initial launch; Ophis runs the
            same bytecode under its own AllowList. <Badge tone="audit">Inherited</Badge>
          </FeatureCard>
          <FeatureCard title="Slither">
            Strict-mode static analysis on all Ophis-deployed contract surfaces (settlement + AllowList + helpers).{' '}
            <Badge tone="live">Clean</Badge>
          </FeatureCard>
          <FeatureCard title="Codex Cyber">
            Cyber-trusted LLM review across the 32-finding 2026-05-18 Phase 2 backend audit + the 2026-05-22 OP-mainnet
            impl-upgrade sweep. <Badge tone="live">Reviewed</Badge>
          </FeatureCard>
          <FeatureCard title="Sharp-edges">
            Multi-round adversarial-pattern review (sharp-edges + silent-failure + adversarial- modeler agents). Added
            the two-step <InlineCode>setManager</InlineCode> hardening on OP-mainnet (PR #224).{' '}
            <Badge tone="live">Reviewed</Badge>
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
              Yes, you sign your swap order with your own wallet. Ophis is non-custodial; the signed order is broadcast
              to the solver network for execution and your funds move only when a solver settles the batch.
            </p>
          </Accordion>
          <Accordion summary="What happens if no solver matches my intent?">
            <p>
              The order expires after its configured validity window (default 30 minutes) and your funds stay in your
              wallet. You can resubmit, change parameters, or cancel at any time.
            </p>
          </Accordion>
          <Accordion summary="Do I pay gas to place an order?">
            <p>
              ERC-20 order signing and off-chain cancellation do not require a network transaction. Token approvals,
              native ETH orders, and on-chain cancellation may require gas. Settlement costs are reflected in the quote.
            </p>
          </Accordion>
          <Accordion summary="Can I use Ophis from my own app?">
            <p>
              Yes. The natural-language intent parser is publicly available at <InlineCode>POST /api/intent</InlineCode>{' '}
              with a 30 req/min/IP rate limit. No auth, no key. See{' '}
              <TextLink href="https://docs.ophis.fi/">the docs</TextLink> for the full reference.
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
