/**
 * Protocol — the trading-mechanism + stack-delta page (Phase A3, 2026-05-25).
 *
 * IA decision (Codex design-partner review, thread 019e5f0b, 2026-05-25):
 * /protocol must NOT become a second /about. /about already owns the
 * company/overview/trust/audit/FAQ story, and docs.ophis.fi owns the full
 * technical reference. So /protocol is scoped as the bridge between them:
 *   - it goes DEEPER than /about's 3-step flow on the actual mechanism, and
 *   - it explicitly delineates WHERE OPHIS DIFFERS from upstream CoW Protocol.
 * The anchor is the "What Ophis adds" comparison Table — the one thing no
 * other surface provides. If this page ever drifts into "what is Ophis / why
 * intents / non-custodial prose / FAQ", that content belongs in /about, not
 * here.
 *
 * Anti-vibe-coding guardrails applied (Codex flagged these as fabrication
 * zones — every claim below is source-verified, not recalled):
 *   - Parser model: functions/api/intent.ts → LIBERTAI_MODEL = 'qwen3.6-27b'.
 *     Framed as "currently" (implementation detail, drift-prone).
 *   - Fee framing mirrors the already-shipped /learn copy (0% ordinary, 25%
 *     of price improvement); caps from app_data.rs (MAX_PARTNER_FEE_BPS=2500,
 *     MAX_PARTNER_VOLUME_BPS=50).
 *   - Chain count "11" mirrors SORTED_CHAIN_IDS (libs/common-const/chainInfo.ts).
 *     Update both together if the chain set changes (known drift source).
 *   - Solana/Bitcoin = destination-only (in SORTED_DST_CHAIN_IDS, NOT
 *     SORTED_CHAIN_IDS). No solver counts, no "best price" guarantees, no MEV
 *     claims beyond intra-batch uniform-price.
 *   - Inherited-from-CoW surfaces Badge tone="audit"; Ophis-operated surfaces
 *     Badge tone="live"; destination-only tone="beta"; testnet/paused tone="draft".
 *
 * AGENTS.md compliance: named export (no default), implementation in
 * *.container.tsx, barrel re-export in index.ts. See pages/Learn for the
 * pattern this mirrors.
 */
import { ReactNode } from 'react'

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
      title="The mechanism behind the sentence."
      lede="How an Ophis trade actually works, from a plain-English intent to batch-auction settlement, and exactly where Ophis differs from the CoW Protocol it forks."
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

      <Section id="lifecycle" title="Intent lifecycle" intro="From a sentence to a settled batch, in five steps.">
        <FeatureGrid minCardWidth="240px">
          <FeatureCard icon="01" title="Describe">
            You type the trade in plain English, &#34;swap 1 ETH for USDC on Base&#34;. No forms, no token-address
            lookups, no network dropdown.
          </FeatureCard>
          <FeatureCard icon="02" title="Parse">
            A server-side open LLM (currently LibertAI <InlineCode>qwen3.6-27b</InlineCode>) extracts the sell token,
            buy token, amount, and chain into a structured order. The parser holds no keys and cannot submit anything.
          </FeatureCard>
          <FeatureCard icon="03" title="Sign">
            You review the pre-filled order and sign it with your own wallet (EIP-712). Nothing leaves your wallet and
            nothing executes until this signature.
          </FeatureCard>
          <FeatureCard icon="04" title="Compete">
            The signed order is broadcast to a batch auction. Solvers race to find the best path, on-chain DEX,
            peer-to-peer match, or cross-chain route, and bid for the right to settle it.
          </FeatureCard>
          <FeatureCard icon="05" title="Settle">
            The winning solver settles your order inside a batch at a uniform clearing price, through CoW Protocol&#39;s{' '}
            <InlineCode>GPv2Settlement</InlineCode> contract.
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
            Orders are collected and settled together on a recurring cadence, rather than executed
            first-come-first-served. There is no per-transaction priority race to win.
          </FeatureCard>
          <FeatureCard title="Coincidence of wants" footer={<Badge tone="audit">Upstream CoW</Badge>}>
            Opposing orders in the same batch can settle directly against each other, a peer-to-peer match that skips
            routing through external liquidity pools.
          </FeatureCard>
          <FeatureCard title="Uniform clearing price" footer={<Badge tone="audit">Upstream CoW</Badge>}>
            Every trade in a batch clears at the same price. That removes the intra-batch ordering value that makes
            front-running and sandwich attacks profitable against ordinary users.
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
              <Td>Natural-language intent parser (server-side LLM)</Td>
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
              <Td>Self-hosted orderbook + driver + solver on Optimism</Td>
              <Td>
                <Badge tone="live">Ophis</Badge>
              </Td>
            </Tr>
            <Tr>
              <RowTh scope="row">Partner fee</RowTh>
              <Td>CIP-75 framework</Td>
              <Td>0% base · capped price-improvement share · allow-listed recipient</Td>
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
              <Td>&mdash;</Td>
              <Td>NEAR Intents → Solana / Bitcoin destinations</Td>
              <Td>
                <Badge tone="beta">Ophis</Badge>
              </Td>
            </Tr>
          </Tbody>
        </Table>
      </Section>

      <Section id="trust-boundaries" title="Trust boundaries" intro="Your signature is the execution boundary.">
        <Callout tone="success" title="The parser cannot move your funds">
          The natural-language parser only fills in a form. It runs server-side, holds no keys, and cannot sign or
          submit an order. Execution begins only when <strong>you</strong> sign, and a solver can act only against the
          exact order you signed.
        </Callout>
        <KeyValueList
          items={[
            {
              label: 'Funds custody',
              value: 'Never held by Ophis. Only the settlement contract moves tokens, and only against a signed order.',
            },
            {
              label: 'Parser authority',
              value: 'None. It suggests a structured order; it cannot sign, submit, or settle.',
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
        intro="Ophis charges nothing on ordinary trades. It takes a share only of price improvement, execution that beats the quote you were shown, and that share is bounded by protocol-enforced CIP-75 caps."
      >
        <FeatureGrid minCardWidth="200px" gap="12px">
          <MetricCard label="Ordinary trades" value="0%" sublabel="when execution does not beat your quote" />
          <MetricCard
            label="Price improvement"
            value="25%"
            sublabel="of execution that beats the quote you were shown"
          />
        </FeatureGrid>
        <p>
          The price-improvement share is capped by CIP-75 validation at <InlineCode>2500</InlineCode> bps, and the total
          fee can never exceed <InlineCode>50</InlineCode> bps (0.5%) of trade volume, a ceiling that protects large
          trades. Values above either cap are rejected at app-data validation as a protocol-level violation.
        </p>
        <KeyValueList
          items={[
            {
              label: 'Fee recipient',
              value:
                'An allow-listed Ophis Safe. The recipient named in app-data is checked against a partner-fee allowlist enforced at validation.',
            },
            {
              label: 'Arbitrary recipients',
              value: 'Rejected, app-data cannot name an unlisted fee recipient (closes audit finding C3).',
            },
            {
              label: 'Full formulas & examples',
              value: (
                <TextLink href="https://docs.ophis.fi/" external>
                  docs.ophis.fi
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
              {/* Count mirrors SORTED_CHAIN_IDS in libs/common-const/chainInfo.ts, update together. */}
              <RowTh scope="row">EVM source chains</RowTh>
              <Td>
                11 production chains selectable in the app, including Ethereum, Arbitrum, Base, Optimism, Polygon
              </Td>
              <Td>
                <Badge tone="live">Selectable</Badge>
              </Td>
            </Tr>
            <Tr>
              <RowTh scope="row">Ophis-operated stack</RowTh>
              <Td>Self-hosted orderbook, driver, and solver. Optimism mainnet</Td>
              <Td>
                <Badge tone="live">Live</Badge>
              </Td>
            </Tr>
            <Tr>
              <RowTh scope="row">Cross-chain destinations</RowTh>
              <Td>Solana and Bitcoin, brokered off-chain via NEAR Intents</Td>
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
            <Tr>
              <RowTh scope="row">Paused</RowTh>
              <Td>HyperEVM, MegaETH, previously announced, not currently routable</Td>
              <Td>
                <Badge tone="draft">Paused</Badge>
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
