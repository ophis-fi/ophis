/**
 * InlineCode — monospace inline `<code>` element with token-aware bg.
 *
 * Use for short technical strings in prose: contract addresses, env-var
 * names, type literals, URL paths. NOT for code blocks (use a different
 * primitive for those — preformatted multi-line code is its own concern).
 */
import { HTMLAttributes, ReactNode } from 'react'

import styled from 'styled-components/macro'

import { STEEP_FONT, steep } from './steep.utils'

interface InlineCodeProps extends Omit<HTMLAttributes<HTMLElement>, 'children'> {
  children: ReactNode
}

const Code = styled.code`
  font-family: ${STEEP_FONT.mono};
  font-size: 0.875em;
  font-weight: 500;
  color: ${({ theme }) => steep(theme).text};
  background: ${({ theme }) => steep(theme).codeBg};
  padding: 1px 5px;
  border-radius: 6px;
  border: 1px solid ${({ theme }) => steep(theme).cardBorder};
  white-space: nowrap;
`

export function InlineCode({ children, ...rest }: InlineCodeProps): ReactNode {
  return <Code {...rest}>{children}</Code>
}
