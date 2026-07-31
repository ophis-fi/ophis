import styled from 'styled-components/macro'

/**
 * Mounts inside the order-progress FinishedStep card, so it inherits that
 * card's type scale rather than the side rail's glass treatment. The h3
 * mirrors the adjacent "Solver auction rankings" heading.
 */
export const Section = styled.section`
  margin: 12px 0 4px;
  text-align: left;

  > h3 {
    margin: 0 0 2px;
    font-size: 14px;
    font-weight: 600;
  }
`

export const Sub = styled.p`
  margin: 0 0 8px;
  font-size: 12px;
  opacity: 0.65;
`

export const Diagram = styled.img`
  display: block;
  max-width: 100%;
  height: auto;
  border-radius: 12px;
`

export const VenueList = styled.p`
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  opacity: 0.8;
  overflow-wrap: anywhere;
`
