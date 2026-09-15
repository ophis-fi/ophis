/**
 * Badge — short status pill for indicating live/planned/beta/draft state.
 *
 * Codex design-partner review (2026-05-23) explicitly flagged that pages
 * mix live claims and aspirational claims without distinguishing them.
 * Badge fixes that by giving every claim a STATE label.
 *
 * Use the `tone` prop to convey semantics:
 *   - `live`     : in production, verifiable now (green)
 *   - `planned`  : on roadmap, not yet built (peach/brown, the Steep accent)
 *   - `beta`     : live but rough edges (neutral slate)
 *   - `partner`  : depends on a partner agreement (brown outline)
 *   - `draft`    : design/copy not finalized (neutral)
 *   - `audit`    : audited / verifiable artifact (green)
 */
import { ReactNode } from 'react'

import styled from 'styled-components/macro'

import { STEEP_FONT, steep, type SteepToneName } from './steep.utils'

export type BadgeTone = 'live' | 'planned' | 'beta' | 'partner' | 'draft' | 'audit'

interface BadgeProps {
  tone?: BadgeTone
  children: ReactNode
}

const Pill = styled.span<{ $tone: BadgeTone }>`
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  border-radius: 9999px;
  font-family: ${STEEP_FONT.body};
  font-size: 12px;
  font-weight: 500;
  letter-spacing: 0;
  text-transform: none;
  white-space: nowrap;
  border: none;
  color: ${({ theme, $tone }) => steep(theme).tones[$tone as SteepToneName].text};
  border-color: ${({ theme, $tone }) => steep(theme).tones[$tone as SteepToneName].border};
  background: ${({ theme, $tone }) => steep(theme).tones[$tone as SteepToneName].bg};
  font-variant-numeric: lining-nums tabular-nums;
`

export function Badge({ tone = 'live', children }: BadgeProps): ReactNode {
  return <Pill $tone={tone}>{children}</Pill>
}
