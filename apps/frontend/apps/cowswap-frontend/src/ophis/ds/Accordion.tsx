/**
 * Accordion — collapsible content built on native `<details>` + `<summary>`.
 *
 * Native HTML element gives us full keyboard / screen-reader accessibility
 * for free (space/enter toggles, aria-expanded handled by the browser).
 * `open` prop allows initial-open state for the first item in a stack.
 *
 * For FAQ-style stacks, wrap multiple `<Accordion>` in `<AccordionGroup>`.
 * Group renders a vertical list with hairline dividers between rows.
 */
import { DetailsHTMLAttributes, ReactNode } from 'react'

import styled from 'styled-components/macro'

interface AccordionProps extends Omit<DetailsHTMLAttributes<HTMLDetailsElement>, 'children'> {
  /** Trigger row — what the user clicks to expand. Typically a short question. */
  summary: ReactNode
  /** Body — answer / explanation / disclosure. */
  children: ReactNode
}

const Details = styled.details`
  border-radius: 10px;
  padding: 0;
  background: transparent;
`

const Summary = styled.summary`
  cursor: pointer;
  font-family: 'Fraunces', var(--cow-font-family-primary, system-ui);
  font-weight: 500;
  font-size: 17px;
  letter-spacing: -0.005em;
  color: #f5efe6;
  padding: 14px 16px;
  border-radius: 10px;
  display: flex;
  align-items: center;
  gap: 12px;
  list-style: none; /* Hide the default triangle so we can render our own glyph. */
  transition: background-color 120ms ease-out;

  &::-webkit-details-marker {
    display: none;
  }

  &:hover {
    background-color: rgba(245, 239, 230, 0.04);
  }

  &:focus-visible {
    outline: 2px solid rgba(242, 166, 62, 0.5);
    outline-offset: 2px;
  }

  &::after {
    content: '+';
    margin-left: auto;
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    font-size: 18px;
    color: #f2a63e;
    transition: transform 160ms ease-out;
  }

  ${Details}[open] > &::after {
    content: '−';
  }
`

const Body = styled.div`
  padding: 0 16px 16px;
  color: rgba(245, 239, 230, 0.78);
  font-size: 15px;
  line-height: 1.65;

  & > p {
    margin: 0;
  }
  & > p + p {
    margin-top: 10px;
  }
`

export function Accordion({ summary, children, ...rest }: AccordionProps): ReactNode {
  return (
    <Details {...rest}>
      <Summary>{summary}</Summary>
      <Body>{children}</Body>
    </Details>
  )
}

export const AccordionGroup = styled.div`
  display: flex;
  flex-direction: column;
  border-top: 1px solid rgba(245, 239, 230, 0.08);

  & > details {
    border-bottom: 1px solid rgba(245, 239, 230, 0.08);
  }
`
