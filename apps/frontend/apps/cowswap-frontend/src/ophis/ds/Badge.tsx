/**
 * Badge — short status pill for indicating live/planned/beta/draft state.
 *
 * Codex design-partner review (2026-05-23) explicitly flagged that pages
 * mix live claims and aspirational claims without distinguishing them.
 * Badge fixes that by giving every claim a STATE label.
 *
 * Use the `tone` prop to convey semantics:
 *   - `live`     : in production, verifiable now (green)
 *   - `planned`  : on roadmap, not yet built (saffron)
 *   - `beta`     : live but rough edges (lavender)
 *   - `partner`  : depends on a partner agreement (rose)
 *   - `draft`    : design/copy not finalized (cream-dim, neutral)
 *   - `audit`    : audited / verifiable artifact (mint)
 */
import { ReactNode } from 'react'

import styled, { css } from 'styled-components/macro'

export type BadgeTone = 'live' | 'planned' | 'beta' | 'partner' | 'draft' | 'audit'

interface BadgeProps {
  tone?: BadgeTone
  children: ReactNode
}

const TONE_STYLES: Record<BadgeTone, ReturnType<typeof css>> = {
  live: css`
    color: #6dcfa1;
    border-color: rgba(109, 207, 161, 0.45);
    background: rgba(109, 207, 161, 0.1);
  `,
  planned: css`
    color: #f2a63e;
    border-color: rgba(242, 166, 62, 0.5);
    background: rgba(242, 166, 62, 0.08);
  `,
  beta: css`
    color: #b48aff;
    border-color: rgba(180, 138, 255, 0.45);
    background: rgba(180, 138, 255, 0.08);
  `,
  partner: css`
    color: #ff8aa8;
    border-color: rgba(255, 138, 168, 0.45);
    background: rgba(255, 138, 168, 0.08);
  `,
  draft: css`
    color: rgba(245, 239, 230, 0.6);
    border-color: rgba(245, 239, 230, 0.2);
    background: rgba(245, 239, 230, 0.04);
  `,
  audit: css`
    color: #6ad6c1;
    border-color: rgba(106, 214, 193, 0.45);
    background: rgba(106, 214, 193, 0.08);
  `,
}

const Pill = styled.span<{ $tone: BadgeTone }>`
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  border-radius: 4px;
  font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, monospace;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  white-space: nowrap;
  border: 1px solid;
  ${({ $tone }) => TONE_STYLES[$tone]}
`

export function Badge({ tone = 'live', children }: BadgeProps): ReactNode {
  return <Pill $tone={tone}>{children}</Pill>
}
