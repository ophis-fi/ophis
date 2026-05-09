/**
 * Ophis-branded site header. Used on every route.
 *
 * The right side accepts arbitrary children — the landing supplies its
 * own nav links + Open-Swap button; other routes supply cowswap's
 * NetworkAndAccountControls so users can connect their wallet from
 * within the manual-swap surface.
 */
import { ReactNode } from 'react'

import { Link } from 'react-router'
import styled from 'styled-components/macro'

interface Props {
  children?: ReactNode
  /** Render with a transparent background to overlay the cosmic hero. */
  transparent?: boolean
}

const Bar = styled.header<{ $transparent: boolean }>`
  position: ${({ $transparent }) => ($transparent ? 'absolute' : 'sticky')};
  top: 0;
  left: 0;
  right: 0;
  z-index: 50;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 22px 36px;
  width: 100%;
  background: ${({ $transparent }) =>
    $transparent ? 'transparent' : 'rgba(2, 0, 13, 0.86)'};
  backdrop-filter: ${({ $transparent }) => ($transparent ? 'none' : 'blur(16px)')};
  border-bottom: 1px solid
    ${({ $transparent }) => ($transparent ? 'transparent' : 'rgba(245, 239, 230, 0.08)')};
  @media (max-width: 600px) {
    padding: 18px 20px;
  }
`

const Wordmark = styled(Link)`
  font-family: 'Fraunces', var(--cow-font-family-primary, system-ui);
  font-weight: 600;
  font-size: 22px;
  letter-spacing: -0.01em;
  color: #f5efe6;
  text-decoration: none;
  user-select: none;
  display: inline-flex;
  align-items: baseline;
  gap: 4px;
  &:hover {
    color: #ffffff;
  }
`

const WordmarkAccent = styled.span`
  color: #f2a63e;
`

const Right = styled.div`
  display: flex;
  align-items: center;
  gap: 14px;
`

export function OphisHeader({ children, transparent = false }: Props): ReactNode {
  return (
    <Bar $transparent={transparent}>
      <Wordmark to="/">
        ophis<WordmarkAccent>.</WordmarkAccent>
      </Wordmark>
      <Right>{children}</Right>
    </Bar>
  )
}
