/**
 * InlineCode — monospace inline `<code>` element with token-aware bg.
 *
 * Use for short technical strings in prose: contract addresses, env-var
 * names, type literals, URL paths. NOT for code blocks (use a different
 * primitive for those — preformatted multi-line code is its own concern).
 */
import { HTMLAttributes, ReactNode } from 'react'

import styled from 'styled-components/macro'

interface InlineCodeProps extends Omit<HTMLAttributes<HTMLElement>, 'children'> {
  children: ReactNode
}

const Code = styled.code`
  font-family: 'Geist Mono', ui-monospace, SFMono-Regular, monospace;
  font-size: 0.875em;
  font-weight: 500;
  color: #f5efe6;
  background: rgba(245, 239, 230, 0.08);
  padding: 1px 5px;
  border-radius: 4px;
  border: 1px solid rgba(245, 239, 230, 0.06);
  white-space: nowrap;
`

export function InlineCode({ children, ...rest }: InlineCodeProps): ReactNode {
  return <Code {...rest}>{children}</Code>
}
