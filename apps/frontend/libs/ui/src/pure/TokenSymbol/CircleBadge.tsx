import { ReactNode, useState } from 'react'

import { t } from '@lingui/core/macro'
import styled from 'styled-components/macro'

import Popover from '../Popover'

const Badge = styled.span`
  display: inline-flex;
  margin-left: 4px;
  vertical-align: -2px;
  color: #2775ca;
  cursor: help;
`

const Description = styled.span`
  display: block;
  max-width: 240px;
  margin-top: 4px;
  font-weight: 400;
  line-height: 1.4;
`

export function CircleBadge({ restricted }: { restricted: boolean }): ReactNode {
  const [show, setShow] = useState(false)
  const label = t`Official Circle token`
  const description = restricted
    ? t`Contract verified against Circle's registry. USYC requires an eligible, allowlisted wallet.`
    : t`Contract verified against Circle's registry.`

  return (
    <Popover
      inline
      show={show}
      placement="top"
      content={
        <span role="tooltip">
          <strong>{label}</strong>
          <Description>{description}</Description>
        </span>
      }
    >
      <Badge
        role="img"
        aria-label={`${label}. ${description}`}
        onMouseEnter={() => setShow(true)}
        onMouseLeave={() => setShow(false)}
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <circle cx="8" cy="8" r="8" fill="currentColor" />
          <path
            d="m4.5 8 2.25 2.25 4.75-4.75"
            stroke="white"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </Badge>
    </Popover>
  )
}
