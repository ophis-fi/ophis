/**
 * About Ophis.
 *
 * Phase A3 rebuild (PR #248, 2026-05-23) — replaces the 2026-05-22
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
 *   - Who operates Ophis (Commit Media S.à r.l. KeyValueList stub)
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
  KeyValueList,
  PageShell,
  Section,
  TextLink,
} from 'ophis/ds'

export default function AboutPage(): ReactNode {
  return (
    <PageShell
      width="medium"
      eyebrow="About Ophis"
      title="Plain English to settled trade."
      lede="Tell us what to trade. We pre-fill the form. You sign. The trade settles in a batch auction with MEV protection by construction."
    >
      <Section id="what" title="What is Ophis">
        <p>
          Ophis is an intent-based DEX aggregator built on{' '}
          <TextLink href="https://cow.fi" external>
            CoW Protocol
          </TextLink>
          . You describe what you want to trade in plain English; we parse the tokens, chain, and
          amount, then route you to a pre-filled swap form that you sign with your own wallet.
        </p>
        <p>
          Under the hood, every order is broadcast to a network of competing solvers who race to
          find the best path. The winning route settles on-chain through CoW Protocol&#39;s
          audited <InlineCode>GPv2Settlement</InlineCode> contract — at a uniform clearing price,
          inside a batch auction where front-running and sandwich attacks are eliminated by
          construction.
        </p>
      </Section>

      <Section
        id="how"
        title="How it works"
        intro="Three steps from your sentence to settlement."
      >
        <FeatureGrid minCardWidth="280px">
          <FeatureCard icon="01" title="Intent">
            You type a swap in plain English. An open LLM (LibertAI Qwen 3.5) extracts the sell
            token, buy token, amount, and chain into a structured order.
          </FeatureCard>
          <FeatureCard icon="02" title="Auction">
            The signed order is broadcast to the batch auction. Solvers race to find the best
            path — DEX, peer-to-peer match, or cross-chain bridge — and bid for the right to
            settle.
          </FeatureCard>
          <FeatureCard icon="03" title="Settle">
            The winning solver settles your order in a batch where every trade clears at the same
            uniform price. No front-running, no sandwich, no priority-gas auction.
          </FeatureCard>
        </FeatureGrid>
      </Section>

      <Section id="why" title="Why intent-based">
        <p>
          A traditional DEX form asks you to fill four fields, validate two token addresses, and
          understand which network you&#39;re on before you can start trading. Ophis flips that:
          type the trade as a sentence, our parser translates it into protocol primitives, and the
          interface shows you exactly what will be signed before any transaction leaves your wallet.
        </p>
        <p>
          The parser is open and the routing layer is transparent. There&#39;s no proprietary
          black box between your intent and the on-chain order.
        </p>
      </Section>

      <Section id="non-custodial" title="Non-custodial by design">
        <Callout tone="success" title="Your keys, your tokens">
          Ophis never holds your funds. Orders are signed locally by your wallet, broadcast
          off-chain to a network of competing solvers, and settled through the audited GPv2
          Settlement contract under Ophis&#39;s own allow-listed solver set on supported chains.
        </Callout>
        <p>
          The protocol itself executes settlements; the Ophis interface only routes intents.
          Ophis cannot move your tokens — only the protocol can, and only against an order you
          signed.
        </p>
      </Section>

      <Section id="mev" title="MEV-protected">
        <p>
          Every order is settled inside a <strong>batch auction at a uniform clearing price</strong>.
          Front-running and sandwich attacks are eliminated by construction — the protocol does
          not reorder transactions for value, so there is no priority-gas auction to win against
          you.
        </p>
      </Section>

      <Section
        id="cross-chain"
        title="Cross-chain via NEAR Intents"
        intro="Trade from any EVM chain to Solana or Bitcoin without a second wallet."
      >
        <p>
          NEAR Intents brokers the bridge step off-chain. You sign with your EVM wallet, paste a
          destination address (base58 for Solana, native format for Bitcoin), and the solver
          network handles the rest.
        </p>
        <Callout tone="info" title="Destination-only today">
          Solana and Bitcoin can be receive addresses but not source chains. Ophis runs on EVM
          wallet infrastructure (wagmi + WalletConnect / MetaMask / Safe / Coinbase). Native
          Solana / Bitcoin wallet connect is not on the roadmap.
        </Callout>
      </Section>

      <Section id="audits" title="Audited infrastructure">
        <p>
          The settlement layer is the GPv2 contracts from CoW Protocol — audited by{' '}
          <TextLink href="https://github.com/trailofbits/publications" external>
            Trail of Bits
          </TextLink>{' '}
          and G0. Ophis-specific solver wiring, the partner-fee plumbing, and the driver-level
          Custom-interaction allowlist were re-audited in May 2026 via Slither strict, Halmos,
          Trail of Bits agent suite, and Codex Cyber. Sharp-edges multi-round review added a
          two-step manager-transfer hardening on the OP-mainnet AllowList contract.
        </p>
        <FeatureGrid minCardWidth="200px" gap="12px">
          <FeatureCard title="Trail of Bits">
            Settlement + AllowList suite audited via guidelines-advisor, code-maturity, token-
            integration, and audit-prep agents.{' '}
            <Badge tone="audit">Audited</Badge>
          </FeatureCard>
          <FeatureCard title="Slither">
            Strict-mode static analysis on all contract surfaces.{' '}
            <Badge tone="audit">Clean</Badge>
          </FeatureCard>
          <FeatureCard title="Halmos">
            Symbolic execution as a Verity-equivalent for property checks.{' '}
            <Badge tone="audit">Clean</Badge>
          </FeatureCard>
          <FeatureCard title="Codex Cyber">
            Cyber-trusted LLM review across 32-finding Phase 2 backend audit.{' '}
            <Badge tone="audit">Pass</Badge>
          </FeatureCard>
        </FeatureGrid>
      </Section>

      <Section id="open-source" title="Open source">
        <p>
          Ophis is open source under the GNU LGPL v3.0 (frontend) and CoW Protocol&#39;s upstream
          licenses (smart contracts, backend services). Code, deployment artefacts, and audit
          reports are public.
        </p>
        <p>
          <TextLink href="https://github.com/ophis-fi/ophis" external>
            View the code on GitHub
          </TextLink>
          {' · '}
          <TextLink href="/docs">Read the docs</TextLink>
        </p>
      </Section>

      <Section id="operator" title="Who operates Ophis">
        <p>
          The interface at <InlineCode>ophis.fi</InlineCode> is operated by{' '}
          <strong>COMMIT MEDIA S.à r.l.</strong>, a Luxembourg consultancy company. Full
          legal-entity disclosure on the <TextLink href="/legal">Legal page</TextLink>.
        </p>
        <KeyValueList
          items={[
            { label: 'Operator', value: 'COMMIT MEDIA S.à r.l.' },
            { label: 'Jurisdiction', value: 'Grand Duchy of Luxembourg' },
            { label: 'RCS', value: 'B276192' },
            { label: 'Contact', value: <TextLink href="mailto:clement@openletz.com">clement@openletz.com</TextLink> },
          ]}
        />
      </Section>

      <Section id="faq" title="Common questions" intro="Selected highlights. Full FAQ in the docs.">
        <AccordionGroup>
          <Accordion summary="Do I need to connect a wallet?">
            <p>
              Yes — you sign your swap order with your own wallet. Ophis is non-custodial; the
              signed order is broadcast to the solver network for execution and your funds move
              only when a solver settles the batch.
            </p>
          </Accordion>
          <Accordion summary="What happens if no solver matches my intent?">
            <p>
              The order expires after its configured validity window (default 30 minutes) and your
              funds stay in your wallet. You can resubmit, change parameters, or cancel at any
              time.
            </p>
          </Accordion>
          <Accordion summary="Is the natural-language parser reliable?">
            <p>
              The parser is best-effort. Ambiguous or malformed intents fall through to a
              standard swap form with whatever fields the parser could extract — you can correct
              before signing. Nothing executes until you sign.
            </p>
          </Accordion>
          <Accordion summary="Can I use Ophis from my own app?">
            <p>
              Yes. The natural-language → structured-order endpoint is publicly available at{' '}
              <InlineCode>POST /api/intent</InlineCode> with a 30 req/min/IP rate limit. No auth,
              no key. See <TextLink href="/docs">the docs</TextLink> for the full reference.
            </p>
          </Accordion>
        </AccordionGroup>
        <p>
          <TextLink href="/docs#faq">All FAQs in the docs →</TextLink>
        </p>
      </Section>
    </PageShell>
  )
}
