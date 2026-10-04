/**
 * Protocol - the trading-mechanism + stack-delta page (Phase A3, 2026-05-25).
 *
 * IA decision (Codex design-partner review, thread 019e5f0b, 2026-05-25):
 * /protocol must NOT become a second /about. /about already owns the
 * company/overview/trust/audit/FAQ story, and docs.ophis.fi owns the full
 * technical reference. So /protocol is scoped as the bridge between them:
 *   - it goes DEEPER than /about's 3-step flow on the actual mechanism, and
 *   - it explicitly delineates WHERE OPHIS DIFFERS from upstream CoW Protocol.
 * The anchor is the "What Ophis adds" comparison Table - the one thing no
 * other surface provides. If this page ever drifts into "what is Ophis / why
 * intents / non-custodial prose / FAQ", that content belongs in /about, not
 * here.
 *
 * Anti-vibe-coding guardrails applied (Codex flagged these as fabrication
 * zones - every claim below is source-verified, not recalled):
 *   - Order entry is the structured in-app swap form. The
 *     natural-language → structured-order endpoint remains a developer
 *     API (POST /api/intent); it is not presented as the pretrade UX.
 *   - Fee framing mirrors the /learn copy and docs.ophis.fi/fees (0.01%
 *     base plus capped improvement capture). Source of truth: ophis/partnerFeeDefault.ts, which mirrors
 *     packages/sdk/src/partner-fee.ts. Update all fee copy together.
 *   - External NEAR networks use separate source/deposit and destination flows;
 *     EVM order builders do not cover those deposits.
 *   - Inherited-from-CoW surfaces Badge tone="audit"; Ophis-operated surfaces
 *     Badge tone="live"; destination-only tone="beta"; testnet/paused tone="draft".
 *
 * AGENTS.md compliance: named export (no default), implementation in
 * *.container.tsx, barrel re-export in index.ts. See pages/Learn for the
 * pattern this mirrors.
 */
import { ReactNode } from 'react'

import { BRIDGE_ONLY_DESTINATION_LABELS_TEXT } from '@cowprotocol/common-const'

import {
  Badge,
  Callout,
  FeatureCard,
  FeatureGrid,
  InlineCode,
  KeyValueList,
  MetricCard,
  PageShell,
  RowTh,
  Section,
  Table,
  Tbody,
  Td,
  Th,
  Thead,
  TextLink,
  Tr,
} from 'ophis/ds'

// eslint-disable-next-line max-lines-per-function -- static content page; single ds/ composition with no logic to extract, mirrors sibling /about + /legal + /learn
export function ProtocolPage(): ReactNode {
  return (
    <PageShell
      width="medium"
      eyebrow="Protocol"
      title="The mechanism behind the order."
      lede="How an Ophis trade actually works, from a signed intent to batch-auction settlement, and exactly where Ophis differs from the CoW Protocol it forks."
    >
      <Callout tone="info" title="What this page covers, and what it doesn't">
        <p>
          This is the mechanism page: the order lifecycle, the settlement model Ophis inherits from CoW Protocol, and
          the layers Ophis operates itself. For the product overview, operator entity, and security reviews see{' '}
          <TextLink href="/about">/about</TextLink>; for the full architecture, API, and fee formulas see{' '}
          <TextLink href="https://docs.ophis.fi/" external>
            docs.ophis.fi
          </TextLink>
          .
        </p>
      </Callout>

      <Section id="lifecycle" title="Intent lifecycle" intro="From order to settled batch, in five steps.">
        <FeatureGrid minCardWidth="240px">
          <FeatureCard icon="01" title="Build">
            You build the order in the swap form - &#34;swap 1 ETH for USDC on Base&#34; - picking tokens, amount, and
            chain, with the exact terms shown before anything is signed.
          </FeatureCard>
          <FeatureCard icon="02" title="Check">
            The app validates the sell token, buy token, amount, and chain into a structured order and shows you exactly
            what you will sign. Nothing is submitted until you sign.
          </FeatureCard>
          <FeatureCard icon="03" title="Sign">
            You authorize the order with your wallet. ERC-20 orders typically use an off-chain signature; approvals,
            native-token swaps, and Safe transactions can require on-chain steps.
          </FeatureCard>
          <FeatureCard icon="04" title="Compete">
            The authorized order enters an auction. Solvers compete to find an execution route through available
            liquidity and bid for the right to settle it.
          </FeatureCard>
          <FeatureCard icon="05" title="Settle">
            The winning solver settles the source-chain order through CoW Protocol&#39;s{' '}
            <InlineCode>GPv2Settlement</InlineCode> contract. Cross-chain routes also depend on the selected bridge for
            destination delivery.
          </FeatureCard>
        </FeatureGrid>
      </Section>

      <Section
        id="cow-mechanism"
        title="Inherited from CoW Protocol"
        intro="The settlement engine is CoW Protocol, unmodified. These properties come from the protocol Ophis forked, not from anything Ophis built."
      >
        <FeatureGrid minCardWidth="240px">
          <FeatureCard title="Batch auctions" footer={<Badge tone="audit">Upstream CoW</Badge>}>
            Eligible orders compete in recurring auctions and may settle together in a batch.
          </FeatureCard>
          <FeatureCard title="Coincidence of wants" footer={<Badge tone="audit">Upstream CoW</Badge>}>
            CoW settlement supports matching opposing orders directly. Ophis-operated solvers currently quote individual
            orders against liquidity sources; they do not match peer orders.
          </FeatureCard>
          <FeatureCard title="Uniform clearing price" footer={<Badge tone="audit">Upstream CoW</Badge>}>
            A settled batch uses uniform clearing prices per token pair under the settlement rules. This reduces
            intra-batch ordering advantages; external liquidity and bridge execution retain their own MEV risks.
          </FeatureCard>
          <FeatureCard title="GPv2 settlement contract" footer={<Badge tone="audit">Unmodified</Badge>}>
            Ophis runs CoW Protocol&#39;s audited <InlineCode>GPv2Settlement</InlineCode> bytecode as deployed, under
            its own allow-listed solver set. No contract fork, no custom settlement logic.
          </FeatureCard>
        </FeatureGrid>
      </Section>

      <Section
        id="ophis-delta"
        title="What Ophis adds"
        intro="Ophis changes the interface and operates its own execution stack. It does not change the settlement contract. This table is the line between &ldquo;CoW Protocol&rdquo; and &ldquo;Ophis&rdquo;."
      >
        <Table caption="Layer-by-layer comparison of upstream CoW Protocol and the Ophis stack">
          <Thead>
            <Tr>
              <Th scope="col">Layer</Th>
              <Th scope="col">CoW Protocol</Th>
              <Th scope="col">Ophis</Th>
              <Th scope="col">Status</Th>
            </Tr>
          </Thead>
          <Tbody>
            <Tr>
              <RowTh scope="row">Order entry</RowTh>
              <Td>Structured swap form</Td>
              <Td>Structured swap form + intent API for developers</Td>
              <Td>
                <Badge tone="live">Ophis</Badge>
              </Td>
            </Tr>
            <Tr>
              <RowTh scope="row">Settlement contract</RowTh>
              <Td>
                <InlineCode>GPv2Settlement</InlineCode>
              </Td>
              <Td>Same bytecode, unmodified</Td>
              <Td>
                <Badge tone="audit">Inherited</Badge>
              </Td>
            </Tr>
            <Tr>
              <RowTh scope="row">Solver set</RowTh>
              <Td>CoW solver competition</Td>
              <Td>Ophis-operated, allow-listed solver set</Td>
              <Td>
                <Badge tone="live">Ophis</Badge>
              </Td>
            </Tr>
            <Tr>
              <RowTh scope="row">Backend services</RowTh>
              <Td>CoW-operated</Td>
              <Td>
                Ophis-operated orderbooks, drivers, and solver lanes on Optimism, Unichain, Robinhood Chain, and Arc
              </Td>
              <Td>
                <Badge tone="live">Ophis</Badge>
              </Td>
            </Tr>
            <Tr>
              <RowTh scope="row">Partner fee</RowTh>
              <Td>CIP-75 framework</Td>
              <Td>1 bp base + capped improvement capture on every chain · allow-listed recipient</Td>
              <Td>
                <Badge tone="live">Ophis</Badge>
              </Td>
            </Tr>
            <Tr>
              <RowTh scope="row">Hook safety</RowTh>
              <Td>HooksTrampoline isolation</Td>
              <Td>+ denylist on protocol-contract hook targets</Td>
              <Td>
                <Badge tone="live">Ophis</Badge>
              </Td>
            </Tr>
            <Tr>
              <RowTh scope="row">Cross-chain</RowTh>
              <Td>None</Td>
              <Td>NEAR Intents → Solana / Bitcoin destinations</Td>
              <Td>
                <Badge tone="beta">Ophis</Badge>
              </Td>
            </Tr>
          </Tbody>
        </Table>
      </Section>

      <Section id="trust-boundaries" title="Trust boundaries" intro="Your signature is the execution boundary.">
        <Callout tone="success" title="The interface cannot move your funds">
          The interface prepares and submits orders you authorize. It holds no wallet keys and cannot sign without your
          wallet authorization. A solver can execute only within the limits of your signed order.
        </Callout>
        <KeyValueList
          items={[
            {
              label: 'Funds custody',
              value:
                'Ophis holds no wallet keys. Approvals, native-token escrow, and bridge deposits have separate contract permissions.',
            },
            {
              label: 'Interface authority',
              value: 'Prepares and submits authorized orders; signatures require wallet authorization.',
            },
            {
              label: 'Wallet support',
              value: 'EVM wallets only (wagmi / WalletConnect / MetaMask / Safe / Coinbase).',
            },
            {
              label: 'Solana & Bitcoin',
              value: 'Receive (destination) addresses only, never source chains or connected wallets.',
            },
          ]}
        />
      </Section>

      <Section
        id="fees"
        title="Fees"
        intro="Ophis charges a 0.01% base fee plus a capped share of eligible price improvement. The base fee applies even when there is no improvement."
      >
        <FeatureGrid minCardWidth="200px" gap="12px">
          <MetricCard label="Base fee" value="0.01%" sublabel="of trade volume (1 bp)" />
          <MetricCard
            label="Volatile pairs"
            value="80%"
            sublabel="of eligible improvement, capped at 0.99% of volume"
          />
          <MetricCard
            label="Stablecoin pairs"
            value="50%"
            sublabel="of eligible improvement, capped at 0.20% of volume"
          />
        </FeatureGrid>
        <p>
          The caps apply to the improvement component; the base fee is additional. On Ophis-operated chains, the backend
          applies the improvement policy to eligible in-market orders. On hosted chains, the order carries both fee
          components, and CoW Protocol fees can also apply. Network, liquidity, bridge, or integrator fees may be
          additional. See the fee policy for the calculation and rebate terms.
        </p>
        <KeyValueList
          items={[
            {
              label: 'Fee recipient',
              value:
                'The designated Ophis Safe. Ophis-operated backends validate the recipient against a partner-fee allowlist.',
            },
            {
              label: 'Arbitrary recipients',
              value: 'Ophis-operated backends reject app-data that names an unlisted fee recipient.',
            },
            {
              label: 'Fee policy',
              value: (
                <TextLink href="https://docs.ophis.fi/fees" external>
                  docs.ophis.fi/fees
                </TextLink>
              ),
            },
          ]}
        />
      </Section>

      <Section
        id="networks"
        title="Network surface"
        intro="The source chains you can trade from, the cross-chain destinations, and where Ophis operates its own stack."
      >
        <Table caption="Ophis network coverage and status by category">
          <Thead>
            <Tr>
              <Th scope="col">Category</Th>
              <Th scope="col">Coverage</Th>
              <Th scope="col">Status</Th>
            </Tr>
          </Thead>
          <Tbody>
            <Tr>
              <RowTh scope="row">EVM source chains</RowTh>
              <Td>
                Ethereum, Arbitrum, Base, Optimism, Unichain, Robinhood Chain, Arc, and other networks in the app&#39;s
                chain selector
              </Td>
              <Td>
                <Badge tone="live">Selectable</Badge>
              </Td>
            </Tr>
            <Tr>
              <RowTh scope="row">Ophis-operated stack</RowTh>
              <Td>
                Ophis-operated orderbooks, drivers, and solver lanes on Optimism, Unichain, Robinhood Chain, and Arc
              </Td>
              <Td>
                <Badge tone="live">Live</Badge>
              </Td>
            </Tr>
            <Tr>
              <RowTh scope="row">Cross-chain destinations</RowTh>
              <Td>Solana, Bitcoin, {BRIDGE_ONLY_DESTINATION_LABELS_TEXT}, brokered off-chain via NEAR Intents</Td>
              <Td>
                <Badge tone="beta">Destination-only</Badge>
              </Td>
            </Tr>
            <Tr>
              <RowTh scope="row">Testnet</RowTh>
              <Td>Sepolia</Td>
              <Td>
                <Badge tone="draft">Testnet</Badge>
              </Td>
            </Tr>
          </Tbody>
        </Table>
        <p>
          You sign with an EVM wallet on a source chain and, for a cross-chain trade, paste a destination address
          (base58 for Solana, native format for Bitcoin). Solana and Bitcoin are never source chains and there is no
          native Solana / Bitcoin wallet connect.
        </p>
      </Section>

      <Section id="read-next" title="Read next" intro="Where this page hands off.">
        <KeyValueList
          items={[
            {
              label: 'Product & operator',
              value: <TextLink href="/about">/about, overview, operator entity, security reviews</TextLink>,
            },
            {
              label: 'Technical reference',
              value: (
                <TextLink href="https://docs.ophis.fi/" external>
                  docs.ophis.fi, architecture, intent API, fee formulas, audit index
                </TextLink>
              ),
            },
            {
              label: 'Guided index',
              value: <TextLink href="/learn">/learn, a map of every Ophis surface</TextLink>,
            },
            {
              label: 'Upstream protocol',
              value: (
                <TextLink href="https://cow.fi/cow-protocol" external>
                  cow.fi/cow-protocol, the settlement layer Ophis inherits (not Ophis documentation)
                </TextLink>
              ),
            },
          ]}
        />
      </Section>
    </PageShell>
  )
}
