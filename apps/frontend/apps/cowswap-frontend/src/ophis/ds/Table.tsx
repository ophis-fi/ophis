/**
 * Table — styled data table for chains × fees, API limits, tier
 * comparison, spec sheets.
 *
 * Composition: thin wrapper around native `<table>` + `<thead>` +
 * `<tbody>` + `<tr>` + `<th>` + `<td>`. We export the styled subparts
 * so consumers can compose freely. Pre-built `<Table>` enforces the
 * brand chrome (paper background, ink foreground, small-caps headers,
 * thin hairlines, tabular figures).
 *
 * On narrow viewports the table allows horizontal scroll via the
 * outer wrapper — avoids breaking the layout on mobile.
 */
import { ReactNode, TableHTMLAttributes } from 'react'

import styled from 'styled-components/macro'

import { STEEP_FONT, steep } from './steep.utils'

interface TableProps extends TableHTMLAttributes<HTMLTableElement> {
  /** Optional caption shown above the table (sr-only by default to keep visuals clean). */
  caption?: ReactNode
  children: ReactNode
}

const ScrollWrapper = styled.div`
  width: 100%;
  overflow-x: auto;
  border-radius: 16px;
  border: 1px solid ${({ theme }) => steep(theme).cardBorder};
`

const StyledTable = styled.table`
  width: 100%;
  border-collapse: collapse;
  font-size: 14px;
  background: ${({ theme }) => steep(theme).card};

  /* Header band has a fog background so it visually anchors the
     column labels. Sticky positioning is NOT used here. Codex PR #247
     audit pointed out that the ScrollWrapper's \`overflow-x: auto\`
     creates a scroll container that prevents \`thead { position: sticky }\`
     from sticking relative to the page viewport. Tall-table sticky-thead
     is its own concern: a future TallTable primitive (or a flag on this
     one) can opt into a vertically-scrolling wrapper with max-height
     where sticky behaves correctly. */
  & thead {
    background: ${({ theme }) => steep(theme).tableHead};
  }
`

const SrCaption = styled.caption`
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
`

export const Th = styled.th`
  text-align: left;
  padding: 12px 16px;
  font-family: ${STEEP_FONT.body};
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: ${({ theme }) => steep(theme).muted};
  border-bottom: 1px solid ${({ theme }) => steep(theme).cardBorder};
  white-space: nowrap;
`

export const Td = styled.td`
  padding: 12px 16px;
  color: ${({ theme }) => steep(theme).text};
  vertical-align: top;
  line-height: 1.5;
  font-variant-numeric: lining-nums tabular-nums;
`

/**
 * Row-header cell — a real `<th scope="row">` (screen readers announce it as
 * the row's label) styled like a Td with slight emphasis. Use for the first
 * column of comparison / spec tables; avoids the bold-centered `<th>` UA
 * default and the column-header styling of `Th`.
 */
export const RowTh = styled.th`
  text-align: left;
  font-weight: 500;
  padding: 12px 16px;
  color: ${({ theme }) => steep(theme).text};
  vertical-align: top;
  line-height: 1.5;
`

export const Tr = styled.tr`
  border-bottom: 1px solid ${({ theme }) => steep(theme).cardBorder};
  transition: background-color 120ms ease-out;

  &:last-child {
    border-bottom: none;
  }

  &:hover ${Td}, &:hover ${RowTh} {
    background: ${({ theme }) => steep(theme).rowHover};
  }
`

export const Thead = styled.thead``

export const Tbody = styled.tbody``

export function Table({ caption, children, ...rest }: TableProps): ReactNode {
  return (
    <ScrollWrapper>
      <StyledTable {...rest}>
        {caption && <SrCaption>{caption}</SrCaption>}
        {children}
      </StyledTable>
    </ScrollWrapper>
  )
}
