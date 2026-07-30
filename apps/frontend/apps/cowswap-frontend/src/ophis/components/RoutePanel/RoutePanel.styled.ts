import styled from 'styled-components/macro'

/**
 * Deliberately mirrors the Trending panel's glass treatment (same width, radius,
 * alphas and shadow) so the side rail reads as one surface rather than a stack of
 * unrelated cards. Keep the two in step if either is restyled.
 *
 * No `position: fixed` descendants: `backdrop-filter` makes this element a
 * containing block, so a fixed child would anchor here instead of the viewport.
 */
export const Panel = styled.aside`
  width: 300px;
  flex: none;
  align-self: flex-start;
  padding: 16px 14px 14px;
  border-radius: 20px;
  background: rgba(255, 255, 255, 0.028);
  border: 1px solid rgba(255, 255, 255, 0.07);
  backdrop-filter: blur(16px);
  box-shadow:
    0 24px 70px rgba(0, 0, 0, 0.5),
    inset 0 1px 0 rgba(255, 255, 255, 0.04);
  color: ${({ theme }) => theme.text1};
`

export const Head = styled.div`
  display: flex;
  align-items: baseline;
  gap: 8px;
`

export const Title = styled.h2`
  margin: 0;
  font-weight: 600;
  font-size: 13.5px;
  letter-spacing: 0.2px;
`

export const Count = styled.span`
  margin-left: auto;
  font-size: 11px;
  opacity: 0.6;
  background: rgba(255, 255, 255, 0.035);
  border: 1px solid rgba(255, 255, 255, 0.06);
  padding: 3px 9px;
  border-radius: 999px;
  white-space: nowrap;
`

export const Lede = styled.p`
  margin: 10px 0 0;
  font-size: 12px;
  line-height: 1.45;
  opacity: 0.72;
`

export const SectionLabel = styled.p`
  margin: 14px 0 6px;
  font-size: 10.5px;
  letter-spacing: 0.6px;
  text-transform: uppercase;
  opacity: 0.45;
`

export const List = styled.ul`
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 2px;
`

export const Row = styled.li`
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 6px;
  border-radius: 8px;
  font-size: 12.5px;

  &:nth-child(odd) {
    background: rgba(255, 255, 255, 0.02);
  }
`

/**
 * A neutral marker, not a liveness indicator. These solvers are CONFIGURED to
 * compete; nothing here claims any of them has bid on this order.
 */
export const Dot = styled.span`
  width: 5px;
  height: 5px;
  flex: none;
  border-radius: 50%;
  background: currentColor;
  opacity: 0.35;
`

export const RowLabel = styled.span`
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`

export const Footer = styled.div`
  margin-top: 12px;
  padding-top: 10px;
  border-top: 1px solid rgba(255, 255, 255, 0.06);
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 11.5px;
  line-height: 1.45;
  opacity: 0.62;
`
