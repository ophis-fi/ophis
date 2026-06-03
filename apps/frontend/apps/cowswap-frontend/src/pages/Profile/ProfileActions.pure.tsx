/**
 * ProfileActions — "What you can do today" 4-card FeatureGrid.
 *
 * Extracted from Profile.container.tsx to keep the page under the
 * 250-LOC AGENTS.md cap. Pure presentational subcomponent.
 */
import { ReactNode } from 'react'

import { FeatureCard, FeatureGrid, TextLink } from 'ophis/ds'

export function ProfileActions(): ReactNode {
  return (
    <FeatureGrid minCardWidth="240px">
      <FeatureCard title="Trade">
        <p>
          Natural-language intents across supported EVM chains, plus Solana and Bitcoin
          destinations via NEAR Intents.
        </p>
        <p>
          <TextLink href="/">Open the trade form →</TextLink>
        </p>
      </FeatureCard>
      <FeatureCard title="About Ophis">
        <p>
          How the protocol works, audit references, what&apos;s live vs planned. All claims
          status-tagged.
        </p>
        <p>
          <TextLink href="/about">About →</TextLink>
        </p>
      </FeatureCard>
      <FeatureCard title="Institutional">
        <p>
          For OTC desks, funds, treasuries. Non-custodial routing, MEV-protected execution,
          transparent fees.
        </p>
        <p>
          <TextLink href="https://business.ophis.fi" external>
            Talk to us →
          </TextLink>
        </p>
      </FeatureCard>
    </FeatureGrid>
  )
}
