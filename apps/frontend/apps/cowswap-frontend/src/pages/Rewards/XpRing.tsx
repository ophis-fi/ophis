/**
 * XpRing — the Rewards page's signature element.
 *
 * XP progress toward the next perk rendered as a ring closing on itself:
 * the ouroboros (the Ophis brand mark) is a circle completing itself, so
 * the metaphor is the brand, not decoration. Solid stroke on a
 * faint track; the count sits in the center in the utility mono face.
 */
import { ReactNode } from 'react'

import styled from 'styled-components/macro'

const SIZE = 148
const STROKE = 10
const RADIUS = (SIZE - STROKE) / 2
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

const Wrap = styled.div`
  position: relative;
  width: ${SIZE}px;
  height: ${SIZE}px;
  flex: 0 0 auto;
`

const Svg = styled.svg`
  display: block;
  transform: rotate(-90deg);

  circle.progress {
    transition: stroke-dashoffset 600ms ease;
  }

  @media (prefers-reduced-motion: reduce) {
    circle.progress {
      transition: none;
    }
  }
`

const Center = styled.div`
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
`

const Count = styled.span`
  font-family: ui-monospace, SFMono-Regular, monospace;
  font-size: 26px;
  font-weight: 600;
  line-height: 1;
`

const Unit = styled.span`
  font-size: 11px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--cow-color-text-opacity-70);
`

interface XpRingProps {
  xp: number
  /** XP needed for the next locked perk; the ring closes as xp approaches it. */
  nextUnlockXp: number | null
}

export function XpRing({ xp, nextUnlockXp }: XpRingProps): ReactNode {
  // All perks unlocked (or none configured): show the ring fully closed.
  const progress = nextUnlockXp && nextUnlockXp > 0 ? Math.min(xp / nextUnlockXp, 1) : 1
  const dashOffset = CIRCUMFERENCE * (1 - progress)
  const center = SIZE / 2

  return (
    <Wrap role="img" aria-label={`${xp.toLocaleString('en-US')} XP`}>
      <Svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} aria-hidden="true">
        <circle
          cx={center}
          cy={center}
          r={RADIUS}
          fill="none"
          stroke="currentColor"
          strokeOpacity={0.12}
          strokeWidth={STROKE}
        />
        <circle
          className="progress"
          cx={center}
          cy={center}
          r={RADIUS}
          fill="none"
          stroke="var(--cow-color-primary)"
          strokeWidth={STROKE}
          strokeLinecap="round"
          strokeDasharray={CIRCUMFERENCE}
          strokeDashoffset={dashOffset}
        />
      </Svg>
      <Center>
        <Count>{xp.toLocaleString('en-US')}</Count>
        <Unit>XP</Unit>
      </Center>
    </Wrap>
  )
}
