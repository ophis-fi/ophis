/**
 * TextLink — branded inline anchor.
 *
 * Standardizes link styling across all body copy so legal/about/learn
 * pages have consistent ink links with underline on hover. For external
 * links, pass `external` to add `target="_blank" rel="noreferrer"` and a
 * subtle ↗ glyph after the label.
 */
import { AnchorHTMLAttributes, ReactNode } from 'react'

import styled from 'styled-components/macro'

import { steep } from './steep.utils'

interface TextLinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'children'> {
  href: string
  external?: boolean
  children: ReactNode
}

const A = styled.a`
  color: ${({ theme }) => steep(theme).link};
  font-weight: 500;
  text-decoration: none;
  text-underline-offset: 3px;
  border-bottom: 1px solid transparent;
  padding-bottom: 1px;
  transition: border-bottom-color 120ms ease-out;

  &:hover {
    border-bottom-color: currentColor;
  }

  &:focus-visible {
    outline: 2px solid ${({ theme }) => steep(theme).link};
    outline-offset: 2px;
    border-radius: 2px;
  }
`

export function TextLink({ href, external, children, ...rest }: TextLinkProps): ReactNode {
  const externalProps = external ? { target: '_blank', rel: 'noreferrer' } : {}
  return (
    <A href={href} {...externalProps} {...rest}>
      {children}
      {external && <span aria-hidden="true"> ↗</span>}
    </A>
  )
}
