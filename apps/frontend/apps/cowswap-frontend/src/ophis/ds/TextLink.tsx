/**
 * TextLink — branded inline anchor.
 *
 * Standardizes link styling across all body copy so legal/about/learn
 * pages have consistent saffron underlined links. For external links,
 * pass `external` to add `target="_blank" rel="noreferrer"` and a
 * subtle ↗ glyph after the label.
 */
import { AnchorHTMLAttributes, ReactNode } from 'react'

import styled from 'styled-components/macro'

interface TextLinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'children'> {
  href: string
  external?: boolean
  children: ReactNode
}

const A = styled.a`
  color: #f2a63e;
  text-decoration: none;
  border-bottom: 1px solid rgba(242, 166, 62, 0.4);
  padding-bottom: 1px;
  transition: border-bottom-color 120ms ease-out;

  &:hover,
  &:focus-visible {
    border-bottom-color: #f2a63e;
  }

  &:focus-visible {
    outline: 2px solid rgba(242, 166, 62, 0.5);
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
