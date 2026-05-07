import { ReactNode } from 'react'

import styled, { css, keyframes } from 'styled-components/macro'

import { OPHIE_PAD_X, OPHIE_PATH, OPHIE_VIEWBOX } from '../ophiePath'

export type OphieAnimation = 'none' | 'spin' | 'spin-fast' | 'pulse'

export type OphieFill =
  | 'coral' // brand/60 — workhorse
  | 'cream' // brand/10 — inverse / dark surfaces
  | 'dark' // neutral/100 — mono dark
  | 'sunset' // gradient — hero only
  | 'currentColor' // inherit

const FILLS: Record<Exclude<OphieFill, 'sunset' | 'currentColor'>, string> = {
  coral: '#E66A55',
  cream: '#FFF3EE',
  dark: '#131214',
}

const spin = keyframes`
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
`

const pulse = keyframes`
  0%, 100% { opacity: 0.85; transform: scale(1); }
  50% { opacity: 1; transform: scale(1.05); }
`

const animations = {
  spin: css`
    animation: ${spin} 4s linear infinite;
  `,
  'spin-fast': css`
    animation: ${spin} 1.6s linear infinite;
  `,
  pulse: css`
    animation: ${pulse} 1.4s ease-in-out infinite;
  `,
  none: css``,
} as const

const Svg = styled.svg<{ $animate: OphieAnimation }>`
  display: block;
  ${({ $animate }) => animations[$animate]};
`

export interface OphieMarkProps {
  /** Pixel size for both width and height. Defaults to 96. */
  size?: number | string
  /** One of the named fill presets, OR a raw color/`url(#...)` string. */
  fill?: OphieFill | string
  /** Animation preset. */
  animate?: OphieAnimation
  /** Optional className for additional styling. */
  className?: string
  /** Aria label for accessibility. Defaults to "Greg". */
  ariaLabel?: string
}

function resolveFill(fill: OphieFill | string | undefined): string {
  if (!fill || fill === 'currentColor') return 'currentColor'
  if (fill === 'sunset') return 'url(#greg-ophie-sunset)'
  if (fill in FILLS) return FILLS[fill as keyof typeof FILLS]
  return fill
}

/**
 * The Greg / Ophie ouroboros mark — single-source SVG component.
 *
 * Use the `fill` prop for the standard variants; pass `'sunset'` to render
 * the hero gradient (a `<defs>` block is included automatically).
 *
 * For animated favicons / loading states, use `animate="spin"` (slow drift)
 * or `animate="spin-fast"` (active loading) or `animate="pulse"` (heartbeat).
 *
 * Brand rule: never apply `'sunset'` fill to UI affordances. Hero only.
 */
export function OphieMark({
  size = 96,
  fill = 'coral',
  animate = 'none',
  className,
  ariaLabel = 'Greg',
}: OphieMarkProps): ReactNode {
  const resolvedFill = resolveFill(fill)
  const needsGradient = fill === 'sunset'

  return (
    <Svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={OPHIE_VIEWBOX}
      width={size}
      height={size}
      $animate={animate}
      className={className}
      role="img"
      aria-label={ariaLabel}
    >
      {needsGradient && (
        <defs>
          <linearGradient id="greg-ophie-sunset" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#FF8A52" />
            <stop offset="30%" stopColor="#FF6B5A" />
            <stop offset="65%" stopColor="#E55A88" />
            <stop offset="100%" stopColor="#A44E91" />
          </linearGradient>
        </defs>
      )}
      <g transform={`translate(${OPHIE_PAD_X},0)`}>
        <path d={OPHIE_PATH} fill={resolvedFill} />
      </g>
    </Svg>
  )
}
