/**
 * Learn — orientation / navigation hub (Phase A3 tail, 2026-05-23).
 *
 * IA decision (Codex 2026-05-23): NOT a content / publication archive.
 * cow.fi/learn ships years of original articles, podcasts, and media
 * coverage. Ophis has none of that yet — a literal copy would be 90%
 * empty placeholders. So /learn is reframed as a GUIDED INDEX of the
 * existing Ophis pages, organized by user intent, with a small
 * upstream-CoW context section clearly separated at the bottom.
 *
 * Codex pre-flight rules applied:
 *   - Title: "Learn Ophis without the guesswork." (anti-marketing)
 *   - Lede: honest about no articles / podcasts / media coverage yet.
 *   - 5 internal clusters first, upstream-CoW external section last.
 *   - Upstream CoW links labeled "Upstream protocol context — not Ophis
 *     documentation, not Ophis policy." Codex was specific about this:
 *     do not imply CoW endorses Ophis or that CoW docs define Ophis.
 *   - No search bar / no article cards / no topic subpages / no
 *     podcasts section / no media coverage — those imply a content
 *     operation that does not exist.
 *   - /profile, /missions, /earn referenced as PLAIN TEXT until their
 *     respective PRs (#255, #256, #257) land, then a follow-up re-links.
 *
 * AGENTS.md compliance (proactive — same constraints as PR #255 Profile):
 *   - Named export (no default).
 *   - Page implementation in *.container.tsx, barrel in index.ts.
 */
import { ReactNode } from 'react'

import { Callout, FeatureCard, FeatureGrid, KeyValueList, PageShell, Section, TextLink } from 'ophis/ds'

// eslint-disable-next-line max-lines-per-function -- static content page; single ds/ composition with no logic to extract
export function LearnPage(): ReactNode {
  return (
    <PageShell
      width="medium"
      eyebrow="Learn, navigation hub"
      title="Learn Ophis without the guesswork."
      lede="A guided index of Ophis pages, live surfaces, and upstream CoW Protocol context. Ophis does not yet publish original articles, podcasts, or media coverage, if and when we do, they should land in their own section below."
    >
      <Callout tone="info" title="What this page is, and isn't">
        <p>
          <strong>This page is</strong> an orientation map. It points at existing Ophis pages, tells you what each
          covers, and links to upstream CoW Protocol material where Ophis inherits behavior from the protocol we forked.
        </p>
        <p>
          <strong>This page is not</strong> a knowledge base, blog, podcast index, or press archive. When we publish
          those, they will appear in clearly-labeled sections, not as placeholders.
        </p>
      </Callout>

      <Section id="start-here" title="Start here" intro="If you're new to Ophis, read these in order.">
        <FeatureGrid minCardWidth="260px">
          <FeatureCard title="About Ophis">
            <p>
              How the protocol works, audit references, what&apos;s live vs planned. All product claims status-tagged.
            </p>
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
              How a swap intent flows through Ophis, describing a trade in natural language, solver competition,
              MEV-protected settlement. Includes a FAQ and API reference.
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
        intro="Mechanics of how Ophis charges (0% on ordinary trades, only a small capped share of price improvement above your quote) and how routing decisions get made."
      >
        <FeatureGrid minCardWidth="260px">
          <FeatureCard title="Trade form">
            <p>
              The actual swap interface. Natural-language intent → pre-filled order → sign and settle. Supports EVM source
              chains and Solana / Bitcoin destinations via NEAR Intents.
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
        intro="Ophis is a fork of CoW Protocol. The contracts, intent format, and solver-competition mechanism are inherited from upstream, so CoW's literature applies where Ophis hasn't yet written its own equivalent. Not Ophis documentation, not Ophis policy."
      >
        <Callout tone="info" title="Read with attribution in mind">
          <p>
            CoW DAO and its publications speak for CoW Protocol, not for Ophis. We link here because the underlying
            mechanism is shared, not because CoW endorses Ophis or because CoW docs define Ophis policy.
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

      <Section
        id="suggest"
        title="Something missing?"
        intro="This page intentionally avoids making content up. If a topic you expect is absent, it's because it doesn't exist on Ophis yet."
      >
        <p>
          Drop a note via the <TextLink href="/contact">contact form</TextLink>, it helps us decide what to document
          next. If and when original Ophis articles or product announcements ship, they should appear in a new section
          above.
        </p>
      </Section>
    </PageShell>
  )
}
