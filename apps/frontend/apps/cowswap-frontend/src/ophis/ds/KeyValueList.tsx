/**
 * KeyValueList — definition list for spec sheets, legal-entity
 * disclosure, contact blocks, API parameter listings.
 *
 * Two-column grid: dim label on the left, regular text on the right.
 * Wraps to two-line on mobile.
 */
import { ReactNode } from 'react'

import styled from 'styled-components/macro'

export interface KeyValueRow {
  /** Label (rendered as `<dt>`). */
  label: ReactNode
  /** Value (rendered as `<dd>`). */
  value: ReactNode
}

interface KeyValueListProps {
  items: KeyValueRow[]
  /** Width of the label column (defaults to `max-content`). */
  labelWidth?: string
}

const Dl = styled.dl<{ $labelWidth: string }>`
  margin: 0;
  display: grid;
  grid-template-columns: ${({ $labelWidth }) => $labelWidth} 1fr;
  gap: 8px 20px;
  font-size: 14px;
  line-height: 1.55;

  @media (max-width: 600px) {
    grid-template-columns: 1fr;
    gap: 12px;
  }
`

const Dt = styled.dt`
  color: rgba(245, 239, 230, 0.55);
  font-family: 'Geist Mono', ui-monospace, SFMono-Regular, monospace;
  font-size: 12px;
  letter-spacing: 0.04em;

  @media (max-width: 600px) {
    margin-bottom: -8px;
  }
`

const Dd = styled.dd`
  margin: 0;
  color: rgba(245, 239, 230, 0.85);
`

export function KeyValueList({ items, labelWidth = 'max-content' }: KeyValueListProps): ReactNode {
  return (
    <Dl $labelWidth={labelWidth}>
      {items.map((item, i) => (
        <ReactNodeFragment key={i}>
          <Dt>{item.label}</Dt>
          <Dd>{item.value}</Dd>
        </ReactNodeFragment>
      ))}
    </Dl>
  )
}

// Tiny inline Fragment wrapper to satisfy React's key requirement on
// adjacent <dt>/<dd> pairs while keeping the actual DOM structure flat.
function ReactNodeFragment({ children }: { children: ReactNode }): ReactNode {
  return <>{children}</>
}
