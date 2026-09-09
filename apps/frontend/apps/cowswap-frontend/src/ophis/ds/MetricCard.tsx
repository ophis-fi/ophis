/**
 * MetricCard — stat display for dashboards, profile pages, missions
 * progress, fee summaries.
 *
 * Layout: small caps label, large value, optional sublabel, optional
 * trend indicator (delta vs previous). Built for the Profile + Missions
 * + Earn dashboards in Phase C, but also usable on About/Institutional
 * for headline numbers. Values use lining + tabular figures.
 */
import { ReactNode } from 'react'

import styled from 'styled-components/macro'

import { STEEP_FONT, steep } from './steep.utils'

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
  border-radius: 16px;
  padding: ${({ $compact }) => ($compact ? '14px 16px' : '24px 22px')};
  background: ${({ theme }) => steep(theme).card};
  border: 1px solid ${({ theme }) => steep(theme).cardBorder};
  display: flex;
  flex-direction: column;
  gap: ${({ $compact }) => ($compact ? '4px' : '6px')};
  transition: border-color 180ms ease-out;
  &:hover {
    border-color: ${({ theme }) => steep(theme).hoverBorder};
  }
`

const Label = styled.div`
  font-family: ${STEEP_FONT.body};
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: ${({ theme }) => steep(theme).muted};
`

const Value = styled.div<{ $compact: boolean }>`
  font-family: ${STEEP_FONT.body};
  font-weight: 500;
  font-size: ${({ $compact }) => ($compact ? '20px' : '32px')};
  line-height: 1.1;
  letter-spacing: -0.01em;
  font-variant-numeric: lining-nums tabular-nums;
  color: ${({ theme }) => steep(theme).text};
`

const Sublabel = styled.div`
  font-size: 13px;
  color: ${({ theme }) => steep(theme).muted};
`

const Trend = styled.div<{ $direction: TrendDirection }>`
  font-family: ${STEEP_FONT.mono};
  font-size: 12px;
  font-weight: 600;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-top: 4px;
  font-variant-numeric: lining-nums tabular-nums;
  color: ${({ theme, $direction }) =>
    $direction === 'flat' ? steep(theme).muted : steep(theme).tones[$direction === 'up' ? 'success' : 'danger'].text};
`

const TREND_GLYPH: Record<TrendDirection, string> = {
  up: '↑',
  down: '↓',
  flat: '→',
}

export function MetricCard({ label, value, sublabel, trend, compact = false }: MetricCardProps): ReactNode {
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
