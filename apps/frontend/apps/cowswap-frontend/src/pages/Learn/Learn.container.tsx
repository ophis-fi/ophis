/** Links to Ophis guides, product pages and attributed upstream protocol context. */
import { ReactNode } from 'react'

import { Callout, FeatureCard, FeatureGrid, KeyValueList, PageShell, Section, TextLink } from 'ophis/ds'

// eslint-disable-next-line max-lines-per-function -- static content page; single ds/ composition with no logic to extract
export function LearnPage(): ReactNode {
  return (
    <PageShell
      width="medium"
      eyebrow="Learn, navigation hub"
      title="Learn Ophis without the guesswork."
      lede="Guides to trading, fees, integrations, and the protocol behind Ophis."
    >
      <Callout tone="info" title="Guides and articles">
        <p>
          Browse the{' '}
          <TextLink href="https://ophis.fi/learn/" external>
            Ophis guides
          </TextLink>{' '}
          for protocol concepts and the{' '}
          <TextLink href="https://ophis.fi/blog/" external>
            blog
          </TextLink>{' '}
          for walkthroughs and product articles.
        </p>
      </Callout>

      <Section id="start-here" title="Start here" intro="If you're new to Ophis, read these in order.">
        <FeatureGrid minCardWidth="260px">
          <FeatureCard title="About Ophis">
            <p>Product overview, supported trading paths, and security references.</p>
            <p>
              <TextLink href="/about">/about →</TextLink>
            </p>
          </FeatureCard>
          <FeatureCard title="Protocol mechanism">
            <p>
              The trading mechanism in depth, intent lifecycle, the batch-auction settlement Ophis inherits from CoW,
              and a layer-by-layer table of exactly what Ophis adds on top.
            </p>
            <p>
              <TextLink href="/protocol">/protocol →</TextLink>
            </p>
          </FeatureCard>
          <FeatureCard title="Docs">
            <p>
              How a swap intent flows through Ophis - building the order, solver competition, MEV-protected settlement.
              Includes a FAQ and API reference.
            </p>
            <p>
              <TextLink href="https://docs.ophis.fi/" external>
                /docs
              </TextLink>
            </p>
          </FeatureCard>
        </FeatureGrid>
      </Section>

      <Section
        id="trading-fees"
        title="Trading, routing, and fees"
        intro="How the 0.01% base fee, capped price-improvement fee, and routing work."
      >
        <FeatureGrid minCardWidth="260px">
          <FeatureCard title="Trade form">
            <p>
              The actual swap interface. Build the order → review → sign and settle. Supports EVM source chains and
              Solana / Bitcoin destinations via NEAR Intents.
            </p>
            <p>
              <TextLink href="/">Open trade form →</TextLink>
            </p>
          </FeatureCard>
        </FeatureGrid>
      </Section>

      <Section
        id="operator-legal"
        title="Operator, legal &amp; institutional"
        intro="Who runs Ophis, the formal terms users accept by trading, the brand kit, and contact paths for material-volume traders."
      >
        <FeatureGrid minCardWidth="260px">
          <FeatureCard title="Legal terms">
            <p>
              10 numbered sections covering Terms of Service, Privacy, third-party services, operator-entity disclosure
              policy, GDPR posture, dispute resolution. Quick summaries above each section.
            </p>
            <p>
              <TextLink href="/legal">/legal →</TextLink>
            </p>
          </FeatureCard>
          <FeatureCard title="Institutional">
            <p>
              For OTC desks, funds, treasuries. Non-custodial routing, MEV-protected execution, transparent fees, API
              access. Material-volume contact channel.
            </p>
            <p>
              <TextLink href="https://business.ophis.fi" external>
                business.ophis.fi →
              </TextLink>
            </p>
          </FeatureCard>
          <FeatureCard title="Brand kit">
            <p>
              Logo lockup, color palette, typography, usage rules. Separate brand-use terms from code license (GPL-3.0
              for code; brand requires explicit permission).
            </p>
            <p>
              <TextLink href="/brand">/brand →</TextLink>
            </p>
          </FeatureCard>
        </FeatureGrid>
      </Section>

      <Section
        id="upstream-cow"
        title="Upstream CoW Protocol context"
        intro="Background on the contracts, intent format, and solver competition inherited from CoW Protocol."
      >
        <Callout tone="info" title="Read with attribution in mind">
          <p>
            These sources describe CoW Protocol. Use Ophis documentation for Ophis fees, networks and integration
            details.
          </p>
        </Callout>
        <KeyValueList
          items={[
            {
              label: 'CoW Protocol docs',
              value: (
                <TextLink href="https://docs.cow.fi/" external>
                  docs.cow.fi
                </TextLink>
              ),
            },
            {
              label: 'CoW Protocol explainer',
              value: (
                <TextLink href="https://cow.fi/cow-protocol" external>
                  cow.fi/cow-protocol
                </TextLink>
              ),
            },
            {
              label: 'CoW DAO governance forum',
              value: (
                <TextLink href="https://forum.cow.fi/" external>
                  forum.cow.fi
                </TextLink>
              ),
            },
          ]}
        />
      </Section>

      <Section id="suggest" title="Something missing?" intro="Send us a documentation question or correction.">
        <p>
          Use the <TextLink href="/contact">contact form</TextLink> to get in touch.
        </p>
      </Section>
    </PageShell>
  )
}
