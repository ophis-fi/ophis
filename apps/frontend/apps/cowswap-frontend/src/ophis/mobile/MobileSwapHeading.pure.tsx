import { ReactNode } from 'react'

import { Trans } from '@lingui/react/macro'
import styled, { keyframes } from 'styled-components/macro'

const rise = keyframes`
  from { opacity: 0; transform: translateY(90%); }
  to { opacity: 1; transform: translateY(0); }
`
const Heading = styled.h1`
  margin: 24px 0 28px;
  font-family: Georgia, ui-serif, serif;
  font-size: clamp(40px, 11vw, 48px);
  font-weight: 400;
  line-height: 1.08;
  letter-spacing: -1.8px;
  text-align: center;
  color: #17191c;
  > span {
    display: block;
    overflow: hidden;
  }
  b,
  em {
    display: inline-block;
    font-weight: 400;
    animation: ${rise} 700ms cubic-bezier(0.22, 1, 0.36, 1) both;
  }
  b + b {
    animation-delay: 75ms;
  }
  em {
    animation-delay: 150ms;
  }
  @media (prefers-reduced-motion: reduce) {
    b,
    em {
      animation: none;
    }
  }
`

export function MobileSwapHeading({ review = false }: { review?: boolean }): ReactNode {
  return (
    <Heading>
      {review ? (
        <>
          <span>
            <b>
              <Trans>Review</Trans>
            </b>{' '}
            <b>
              <Trans>your</Trans>
            </b>
          </span>
          <span>
            <em>
              <Trans>swap.</Trans>
            </em>
          </span>
        </>
      ) : (
        <>
          <span>
            <b>
              <Trans>Swap</Trans>
            </b>{' '}
            <b>
              <Trans>with</Trans>
            </b>
          </span>
          <span>
            <em>
              <Trans>clarity.</Trans>
            </em>
          </span>
        </>
      )}
    </Heading>
  )
}
