/**
 * Pill rendering of one extracted entity (token / chain / amount).
 *
 * V1 ships symbol-text-only chips; the per-entity-type color makes
 * tokens vs chains vs amounts visually distinguishable at a glance.
 * V2 will swap in cowswap's TokenLogo component once we wire the
 * token-list service into this surface.
 */
import { ReactNode } from 'react'

import styled from 'styled-components/macro'

import type { Entity, EntityType } from './types'

const TYPE_LABEL: Record<EntityType, string> = {
  sellToken: 'sell',
  buyToken: 'buy',
  amount: 'amount',
  chain: 'on',
}

const Pill = styled.span<{ $type: EntityType }>`
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border-radius: 999px;
  font-family: var(--cow-font-family-primary);
  font-size: 13px;
  font-weight: 600;
  line-height: 1;
  letter-spacing: 0.01em;
  border: 1px solid;
  background: ${({ $type }) => {
    switch ($type) {
      case 'sellToken':
        return 'rgba(242, 166, 62, 0.12)' /* brand 60 @ 12% */
      case 'buyToken':
        return 'rgba(199, 61, 108, 0.12)' /* accent 60 @ 12% */
      case 'amount':
        return 'rgba(0, 133, 87, 0.12)' /* green 60 @ 12% */
      case 'chain':
        return 'rgba(110, 115, 117, 0.14)' /* neutral 60 @ 14% */
    }
  }};
  border-color: ${({ $type }) => {
    switch ($type) {
      case 'sellToken':
        return '#f2a63e'
      case 'buyToken':
        return '#C73D6C'
      case 'amount':
        return '#008557'
      case 'chain':
        return '#6E7375'
    }
  }};
  color: ${({ $type }) => {
    switch ($type) {
      case 'sellToken':
        return '#a85f0f'
      case 'buyToken':
        return '#7A1A40'
      case 'amount':
        return '#0D4F2B'
      case 'chain':
        return '#2F3133'
    }
  }};
`

const Tag = styled.span`
  font-size: 10px;
  font-weight: 500;
  text-transform: uppercase;
  opacity: 0.7;
  letter-spacing: 0.06em;
`

export function EntityChip({ entity }: { entity: Entity }): ReactNode {
  return (
    <Pill $type={entity.type}>
      <Tag>{TYPE_LABEL[entity.type]}</Tag>
      <span>{entity.value}</span>
    </Pill>
  )
}

export const ChipRow = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  min-height: 26px;
  padding: 8px 4px 0;
  align-items: center;
`
