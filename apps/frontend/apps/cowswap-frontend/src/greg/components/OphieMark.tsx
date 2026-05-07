import { ReactNode } from 'react'

import styled, { css, keyframes } from 'styled-components/macro'

import { OPHIE_PATH_BODY, OPHIE_PATH_SPIKES_BOTTOM, OPHIE_PATH_SPIKES_TOP, OPHIE_VIEWBOX } from '../ophiePath'

export type OphieAnimation = 'none' | 'spin' | 'spin-fast' | 'pulse'

export type OphieFill =
  | 'coral' // legacy alias for `violet` (kept for callers; will resolve to brand/60)
  | 'violet' // brand/60 — primary action workhorse
  | 'cream' // brand/10 — inverse / dark surfaces
  | 'dark' // brand/100 — deep cosmic violet
  | 'sunset' // legacy alias for `cosmic` — hero gradient
  | 'cosmic' // gradient — hero only (cosmic eclipse)
  | 'currentColor' // inherit

const FILLS: Record<Exclude<OphieFill, 'sunset' | 'cosmic' | 'currentColor'>, string> = {
  coral: '#5827E0', // legacy: now resolves to violet
  violet: '#5827E0',
  cream: '#F4F1FF',
  dark: '#0A0435',
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
  /** Aria label for accessibility. Defaults to "Ophis". */
  ariaLabel?: string
}

function resolveFill(fill: OphieFill | string | undefined): string {
  if (!fill || fill === 'currentColor') return 'currentColor'
  if (fill === 'sunset' || fill === 'cosmic') return 'url(#greg-ophie-cosmic)'
  if (fill in FILLS) return FILLS[fill as keyof typeof FILLS]
  return fill
}

/**
 * The Ophie ouroboros mark — single-source SVG component.
 *
 * Renders the three-path Ophie (body + top spikes + bottom-left spikes) at the
 * requested fill. Pass `'cosmic'` (or legacy `'sunset'`) to render the hero
 * eclipse gradient — a `<defs>` block is included automatically.
 *
 * For animated favicons / loading states, use `animate="spin"` (slow drift),
 * `animate="spin-fast"` (active loading), or `animate="pulse"` (heartbeat).
 *
 * Brand rule: never apply `'cosmic'` to UI affordances. Hero only.
 */
export function OphieMark({
  size = 96,
  fill = 'violet',
  animate = 'none',
  className,
  ariaLabel = 'Ophis',
}: OphieMarkProps): ReactNode {
  const resolvedFill = resolveFill(fill)
  const needsGradient = fill === 'sunset' || fill === 'cosmic'

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
          <linearGradient id="greg-ophie-cosmic" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#5827E0" />
            <stop offset="25%" stopColor="#9A34C2" />
            <stop offset="50%" stopColor="#F4A93B" />
            <stop offset="75%" stopColor="#5C219C" />
            <stop offset="100%" stopColor="#0A0435" />
          </linearGradient>
        </defs>
      )}
      <path d={OPHIE_PATH_BODY} fill={resolvedFill} />
      <path d={OPHIE_PATH_SPIKES_TOP} fill={resolvedFill} />
      <path d={OPHIE_PATH_SPIKES_BOTTOM} fill={resolvedFill} />
    </Svg>
  )
}
