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

import { STEEP_FONT, steep } from './steep.utils'

interface AccordionProps extends Omit<DetailsHTMLAttributes<HTMLDetailsElement>, 'children'> {
  /** Trigger row — what the user clicks to expand. Typically a short question. */
  summary: ReactNode
  /** Body — answer / explanation / disclosure. */
  children: ReactNode
}

const Details = styled.details`
  border-radius: 12px;
  padding: 0;
  background: transparent;
`

const Summary = styled.summary`
  cursor: pointer;
  font-family: ${STEEP_FONT.body};
  font-weight: 500;
  font-size: 16px;
  letter-spacing: -0.005em;
  color: ${({ theme }) => steep(theme).text};
  padding: 14px 16px;
  min-height: 44px;
  border-radius: 12px;
  display: flex;
  align-items: center;
  gap: 12px;
  list-style: none; /* Hide the default triangle so we can render our own glyph. */
  transition: background-color 120ms ease-out;

  &::-webkit-details-marker {
    display: none;
  }

  &:hover {
    background-color: ${({ theme }) =>
      theme?.darkMode ? 'rgba(244, 244, 245, 0.05)' : 'var(--ophis-steep-mist, #f2f2f3)'};
  }

  &:focus-visible {
    outline: 2px solid ${({ theme }) => steep(theme).link};
    outline-offset: 2px;
  }

  &::after {
    content: '+';
    margin-left: auto;
    font-family: ${STEEP_FONT.body};
    font-size: 18px;
    font-weight: 400;
    color: ${({ theme }) => steep(theme).secondary};
    transition: transform 160ms ease-out;
  }

  ${Details}[open] > &::after {
    content: '−';
  }
`

const Body = styled.div`
  padding: 0 16px 16px;
  color: ${({ theme }) => steep(theme).muted};
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
  border-top: 1px solid ${({ theme }) => steep(theme).cardBorder};

  & > details {
    border-bottom: 1px solid ${({ theme }) => steep(theme).cardBorder};
    border-radius: 0;
  }
`
