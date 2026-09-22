/**
 * Ophis-branded site footer. Used on every route.
 *
 * Grouped link grid (Codex audit 2026-05-23): the original 14-link
 * single-row layout was too flat to scan. Now organized into four
 * columns by user intent — Product / Resources / Company / Reach.
 *
 * Styled-components extracted to OphisFooter.styled.ts to keep this
 * file under the AGENTS.md 250-LOC cap.
 */
import { ReactNode } from 'react'

import { mountConsentBanner } from 'ophis/analytics'

import * as styledEl from './OphisFooter.styled'

interface Props {
  /** Render with no top border for routes where the body already has its own divider. */
  borderless?: boolean
  /**
   * Slim single-row footer for viewport-fit routes (e.g. the intent landing,
   * which must show all content on one screen with no scroll). Keeps the
   * brand mark, the few essential links, and the copyright on one line. The
   * full four-column footer stays the default on every scrollable route.
   */
  compact?: boolean
}

function CompactFooter({ borderless }: { borderless: boolean }): ReactNode {
  return (
    <styledEl.CompactBar $borderless={borderless}>
      <styledEl.CompactBrand as="a" href="https://ophis.fi/" aria-label="Ophis home">
        <styledEl.BrandIcon src="/ophis-icon.svg" alt="" aria-hidden="true" />
        <styledEl.Wordmark>
          ophis<span>.</span>
        </styledEl.Wordmark>
      </styledEl.CompactBrand>
      <styledEl.CompactLinks aria-label="More from Ophis">
        <styledEl.ExternalLink href="https://docs.ophis.fi/">Docs</styledEl.ExternalLink>
        <styledEl.ExternalLink href="https://ophis.fi/blog/">Blog</styledEl.ExternalLink>
        <styledEl.ExternalLink href="https://x.com/ophisfi" aria-label="Ophis on X">
          X
        </styledEl.ExternalLink>
        <styledEl.ExternalLink href="https://t.me/ophisfi">Telegram</styledEl.ExternalLink>
        <styledEl.InternalLink to="/legal">Legal</styledEl.InternalLink>
        <styledEl.PreferencesButton type="button" onClick={() => mountConsentBanner(true)}>
          Analytics preferences
        </styledEl.PreferencesButton>
      </styledEl.CompactLinks>
      <styledEl.CompactCopy>&copy; Ophis 2026</styledEl.CompactCopy>
      <styledEl.TradeSummary aria-label="About Ophis swaps">
        <details>
          <summary>How Ophis swaps work: networks, fees and wallet approvals</summary>
          <p>
            Ophis Swap is the trading app of Ophis, an intent-based DEX aggregator. Select a network, token pair and
            amount, connect your wallet, and review the available quote before signing. For intent orders, solvers
            compete to settle the trade through batch auctions.
          </p>
          <p>
            Check the minimum received, destination network and spending allowance in your wallet. A token approval can
            require an on-chain transaction before the order signature. Signing an order does not guarantee a fill:
            follow its status until settlement or expiry. MEV protection mitigates common front-running and sandwich
            attacks; token, price and smart-contract risks remain.
          </p>
          <p>
            Supported EVM networks include Ethereum, Base, Arbitrum, BNB Chain, Optimism, Unichain and Robinhood Chain.
            Token availability and executable liquidity depend on the network, pair and amount. The Robinhood Chain
            guide opens network 4663; it does not bridge a balance from another chain. Ophis is independent of Robinhood
            Markets.
          </p>
          <p>
            Developers can access Ophis through its API, MCP server and SDK, or embed the swap widget. AI agent
            integrations and Safe wallet users should also review the selected network, quoted output and approval
            before submitting a trade.
          </p>
          <p>
            Ophis charges a 0.01% base fee plus capped price-improvement capture, measured against a reference quote.
            CoW-hosted swaps also carry upstream fees. Approvals and other on-chain transactions can require network
            gas. Review the quote and current fee policy before signing.
          </p>
        </details>
        <styledEl.CompactLinks aria-label="Swap guides">
          <styledEl.ExternalLink href="/robinhood-chain/">Swap on Robinhood Chain</styledEl.ExternalLink>
          <styledEl.ExternalLink href="https://ophis.fi/pricing/">Fees and pricing</styledEl.ExternalLink>
          <styledEl.ExternalLink href="https://ophis.fi/supported-chains/">Supported chains</styledEl.ExternalLink>
          <styledEl.ExternalLink href="https://ophis.fi/security/">Security</styledEl.ExternalLink>
          <styledEl.ExternalLink href="https://ophis.fi/ai-agent-crypto-swap-api/">
            Agent integrations
          </styledEl.ExternalLink>
        </styledEl.CompactLinks>
      </styledEl.TradeSummary>
    </styledEl.CompactBar>
  )
}

function ReachLinks(): ReactNode {
  return (
    <div>
      <styledEl.ColTitle>Reach</styledEl.ColTitle>
      <styledEl.ColList>
        <li>
          <styledEl.ExternalLink href="https://github.com/ophis-fi/ophis" target="_blank" rel="noreferrer">
            GitHub
          </styledEl.ExternalLink>
        </li>
        <li>
          <styledEl.ExternalLink href="https://x.com/ophisfi" target="_blank" rel="noreferrer">
            X / Twitter
          </styledEl.ExternalLink>
        </li>
        <li>
          <styledEl.ExternalLink href="https://t.me/ophisfi" target="_blank" rel="noreferrer">
            Telegram
          </styledEl.ExternalLink>
        </li>
        <li>
          <styledEl.InternalLink to="/contact">Contact</styledEl.InternalLink>
        </li>
      </styledEl.ColList>
    </div>
  )
}

function FullFooter({ borderless }: { borderless: boolean }): ReactNode {
  return (
    <styledEl.Bar $borderless={borderless}>
      <styledEl.Grid>
        <styledEl.Brand>
          <styledEl.BrandMark>
            <styledEl.BrandIcon src="/ophis-icon.svg" alt="" aria-hidden="true" />
            <styledEl.Wordmark>
              ophis<span>.</span>
            </styledEl.Wordmark>
          </styledEl.BrandMark>
          <styledEl.BrandTagline>
            Best-execution, MEV-protected, intent-based trading. Across 13 EVM chains, including Robinhood Chain, plus
            Solana and Bitcoin destinations.
          </styledEl.BrandTagline>
        </styledEl.Brand>

        <div>
          <styledEl.ColTitle>Product</styledEl.ColTitle>
          <styledEl.ColList>
            <li>
              <styledEl.InternalLink to="/1/swap/_/_">Trade</styledEl.InternalLink>
            </li>
            <li>
              <styledEl.ExternalLink href="/robinhood-chain/">Swap on Robinhood Chain</styledEl.ExternalLink>
            </li>
            <li>
              <styledEl.InternalLink to="/profile">Profile</styledEl.InternalLink>
            </li>
            <li>
              <styledEl.InternalLink to="/profile">Refer and earn</styledEl.InternalLink>
            </li>
            <li>
              <styledEl.InternalLink to="/rewards">Rewards</styledEl.InternalLink>
            </li>
            <li>
              <styledEl.InternalLink to="/leaderboard">Leaderboard</styledEl.InternalLink>
            </li>
          </styledEl.ColList>
        </div>

        <div>
          <styledEl.ColTitle>Resources</styledEl.ColTitle>
          <styledEl.ColList>
            <li>
              <styledEl.ExternalLink href="https://docs.ophis.fi/">Docs</styledEl.ExternalLink>
            </li>
            <li>
              <styledEl.ExternalLink href="https://explorer.ophis.fi/">Explorer</styledEl.ExternalLink>
            </li>
            <li>
              <styledEl.InternalLink to="/learn">Learn</styledEl.InternalLink>
            </li>
            <li>
              <styledEl.InternalLink to="/about">About</styledEl.InternalLink>
            </li>
            <li>
              <styledEl.InternalLink to="/protocol">Protocol</styledEl.InternalLink>
            </li>
            <li>
              <styledEl.InternalLink to="/faq">FAQ</styledEl.InternalLink>
            </li>
          </styledEl.ColList>
        </div>

        <div>
          <styledEl.ColTitle>Company</styledEl.ColTitle>
          <styledEl.ColList>
            <li>
              <styledEl.ExternalLink href="https://business.ophis.fi">Institutional</styledEl.ExternalLink>
            </li>
            <li>
              <styledEl.InternalLink to="/brand">Brand</styledEl.InternalLink>
            </li>
            <li>
              <styledEl.InternalLink to="/legal">Legal</styledEl.InternalLink>
            </li>
          </styledEl.ColList>
        </div>

        <ReachLinks />
      </styledEl.Grid>

      <styledEl.BottomBar>
        <span>© Ophis 2026</span>
        <styledEl.BottomLinks>
          <styledEl.PreferencesButton type="button" onClick={() => mountConsentBanner(true)}>
            Analytics preferences
          </styledEl.PreferencesButton>
          <styledEl.SmallLink to="/legal#privacy">Privacy</styledEl.SmallLink>
          <styledEl.SmallLink to="/brand">Brand kit</styledEl.SmallLink>
        </styledEl.BottomLinks>
      </styledEl.BottomBar>
    </styledEl.Bar>
  )
}

export function OphisFooter({ borderless = false, compact = false }: Props): ReactNode {
  return compact ? <CompactFooter borderless={borderless} /> : <FullFooter borderless={borderless} />
}
