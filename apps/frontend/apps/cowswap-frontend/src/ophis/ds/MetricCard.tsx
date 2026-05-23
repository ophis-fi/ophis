/**
 * MetricCard — stat display for dashboards, profile pages, missions
 * progress, fee summaries.
 *
 * Layout: small caps label, large value, optional sublabel, optional
 * trend indicator (delta vs previous). Built for the Profile + Missions
 * + Earn dashboards in Phase C, but also usable on About/Institutional
 * for headline numbers.
 */
import { ReactNode } from 'react'

import styled, { css } from 'styled-components/macro'

export type TrendDirection = 'up' | 'down' | 'flat'

interface MetricCardProps {
  /** Small caps label above the value. */
  label: ReactNode
  /** The number / string the card centers on. */
  value: ReactNode
  /** Optional secondary text below the value (units, context, etc.). */
  sublabel?: ReactNode
  /** Optional delta indicator. */
  trend?: {
    direction: TrendDirection
    label: ReactNode
  }
  /** Compact variant — half the padding, smaller value text. */
  compact?: boolean
}

const Outer = styled.div<{ $compact: boolean }>`
  border-radius: 12px;
  padding: ${({ $compact }) => ($compact ? '14px 16px' : '24px 22px')};
  background: rgba(245, 239, 230, 0.04);
  border: 1px solid rgba(245, 239, 230, 0.08);
  display: flex;
  flex-direction: column;
  gap: ${({ $compact }) => ($compact ? '4px' : '6px')};
  transition: border-color 180ms ease-out, transform 200ms cubic-bezier(0.16, 1, 0.3, 1);
  &:hover {
    border-color: rgba(242, 166, 62, 0.28);
    transform: translateY(-1px);
  }
  @media (prefers-reduced-motion: reduce) {
    transition: border-color 120ms ease-out;
    &:hover {
      transform: none;
    }
  }
`

const Label = styled.div`
  font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, monospace;
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: rgba(245, 239, 230, 0.6);
`

const Value = styled.div<{ $compact: boolean }>`
  font-family: 'Fraunces', var(--cow-font-family-primary, system-ui);
  font-weight: 500;
  font-size: ${({ $compact }) => ($compact ? '20px' : '32px')};
  line-height: 1.1;
  letter-spacing: -0.01em;
  color: #f5efe6;
`

const Sublabel = styled.div`
  font-size: 13px;
  color: rgba(245, 239, 230, 0.55);
`

const TREND_COLOR: Record<TrendDirection, ReturnType<typeof css>> = {
  up: css`
    color: #6dcfa1;
  `,
  down: css`
    color: #ff8c8c;
  `,
  flat: css`
    color: rgba(245, 239, 230, 0.55);
  `,
}

const TREND_GLYPH: Record<TrendDirection, string> = {
  up: '↑',
  down: '↓',
  flat: '→',
}

const Trend = styled.div<{ $direction: TrendDirection }>`
  font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, monospace;
  font-size: 12px;
  font-weight: 600;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-top: 4px;
  ${({ $direction }) => TREND_COLOR[$direction]}
`

export function MetricCard({
  label,
  value,
  sublabel,
  trend,
  compact = false,
}: MetricCardProps): ReactNode {
  return (
    <Outer $compact={compact}>
      <Label>{label}</Label>
      <Value $compact={compact}>{value}</Value>
      {sublabel && <Sublabel>{sublabel}</Sublabel>}
      {trend && (
        <Trend $direction={trend.direction}>
          <span aria-hidden="true">{TREND_GLYPH[trend.direction]}</span>
          <span>{trend.label}</span>
        </Trend>
      )}
    </Outer>
  )
}
