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

export function OphisFooter({ borderless = false, compact = false }: Props): ReactNode {
  if (compact) {
    return (
      <styledEl.CompactBar $borderless={borderless}>
        <styledEl.CompactBrand>
          <styledEl.BrandIcon src="/ophis-icon.svg" alt="" aria-hidden="true" />
          <styledEl.Wordmark>
            ophis<span>.</span>
          </styledEl.Wordmark>
        </styledEl.CompactBrand>
        <styledEl.CompactLinks>
          <styledEl.ExternalLink href="https://docs.ophis.fi/">Docs</styledEl.ExternalLink>
          <styledEl.InternalLink to="/about">About</styledEl.InternalLink>
          <styledEl.ExternalLink href="https://github.com/ophis-fi/ophis" target="_blank" rel="noreferrer">
            GitHub
          </styledEl.ExternalLink>
          <styledEl.InternalLink to="/legal">Legal</styledEl.InternalLink>
        </styledEl.CompactLinks>
        <styledEl.CompactCopy>&copy; Ophis 2026</styledEl.CompactCopy>
      </styledEl.CompactBar>
    )
  }

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
            Best-execution, MEV-protected, intent-based trading. Across 12 EVM chains, plus Solana and Bitcoin destinations.
          </styledEl.BrandTagline>
        </styledEl.Brand>

        <div>
          <styledEl.ColTitle>Product</styledEl.ColTitle>
          <styledEl.ColList>
            <li>
              <styledEl.InternalLink to="/1/swap/_/_">Trade</styledEl.InternalLink>
            </li>
            <li>
              <styledEl.InternalLink to="/profile">Profile</styledEl.InternalLink>
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

        <div>
          <styledEl.ColTitle>Reach</styledEl.ColTitle>
          <styledEl.ColList>
            <li>
              <styledEl.ExternalLink href="https://github.com/ophis-fi/ophis" target="_blank" rel="noreferrer">
                GitHub
              </styledEl.ExternalLink>
            </li>
            <li>
              <styledEl.InternalLink to="/contact">Contact</styledEl.InternalLink>
            </li>
          </styledEl.ColList>
        </div>
      </styledEl.Grid>

      <styledEl.BottomBar>
        <span>© Ophis 2026</span>
        <styledEl.BottomLinks>
          <styledEl.SmallLink to="/legal#privacy">Privacy</styledEl.SmallLink>
          <styledEl.SmallLink to="/brand">Brand kit</styledEl.SmallLink>
        </styledEl.BottomLinks>
      </styledEl.BottomBar>
    </styledEl.Bar>
  )
}
