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
}

export function OphisFooter({ borderless = false }: Props): ReactNode {
  return (
    <styledEl.Bar $borderless={borderless}>
      <styledEl.Grid>
        <styledEl.Brand>
          <styledEl.BrandMark>
            <styledEl.BrandIcon src="/ophis-icon.svg" alt="" aria-hidden="true" />
            ophis<span>.</span>
          </styledEl.BrandMark>
          <styledEl.BrandTagline>
            Intent-based DEX aggregator. Plain-English swaps across 13 EVM chains, Solana, and
            Bitcoin destinations.
          </styledEl.BrandTagline>
        </styledEl.Brand>

        <div>
          <styledEl.ColTitle>Product</styledEl.ColTitle>
          <styledEl.ColList>
            <li>
              <styledEl.InternalLink to="/1/swap/_/_">Trade</styledEl.InternalLink>
            </li>
            <li>
              <styledEl.InternalLink to="/tiers">Tiers</styledEl.InternalLink>
            </li>
            <li>
              <styledEl.InternalLink to="/missions">Missions</styledEl.InternalLink>
            </li>
            <li>
              <styledEl.InternalLink to="/earn">Earn</styledEl.InternalLink>
            </li>
            <li>
              <styledEl.InternalLink to="/profile">Profile</styledEl.InternalLink>
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
              <styledEl.InternalLink to="/learn">Learn</styledEl.InternalLink>
            </li>
            <li>
              <styledEl.InternalLink to="/about">About</styledEl.InternalLink>
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
              <styledEl.InternalLink to="/institutional">Institutional</styledEl.InternalLink>
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
              <styledEl.ExternalLink href="mailto:contact@3615crypto.com">Email</styledEl.ExternalLink>
            </li>
          </styledEl.ColList>
        </div>
      </styledEl.Grid>

      <styledEl.BottomBar>
        <span>© Ophis 2026</span>
        <styledEl.BottomLinks>
          <styledEl.SmallLink to="/legal">Terms</styledEl.SmallLink>
          <styledEl.SmallLink to="/legal#privacy">Privacy</styledEl.SmallLink>
          <styledEl.SmallLink to="/brand">Brand kit</styledEl.SmallLink>
        </styledEl.BottomLinks>
      </styledEl.BottomBar>
    </styledEl.Bar>
  )
}
