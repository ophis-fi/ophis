import { CSSProperties, ReactNode } from 'react'

import './cosmic-starfield.css'

/**
 * Cosmic starfield — the same soft-dot particles + 4-point sparkle "sparks"
 * that the ophis.fi landing renders, ported into the swap app so swap.ophis.fi
 * shares the same backdrop. Ported 1:1 from apps/ophis-landing
 * (Particles.astro + Sparks.astro + the redesigned `.spark` CSS): a Mulberry32
 * seeded PRNG gives stable positions, and all motion lives in CSS (disabled
 * under prefers-reduced-motion).
 *
 * Pure presentation: a fixed/absolute layer of static <span>s behind content.
 * The only inline styles are CSS custom properties (covered by style-src
 * 'unsafe-inline'); React renders the spans via the bundled JS (script-src
 * 'self'), so there's NO inline-script / CSP-hash impact.
 */

// Mulberry32 — tiny deterministic PRNG (same as the landing) so positions are
// stable across reloads.
function makeRng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const PARTICLE_COUNT = 58
const SPARK_COUNT = 20

const pRng = makeRng(0x9e3779b9)
const particles = Array.from({ length: PARTICLE_COUNT }, () => {
  const depth = pRng()
  const dur = +(18 + pRng() * 24).toFixed(1)
  return {
    left: +(pRng() * 100).toFixed(2),
    top: +(pRng() * 100).toFixed(2),
    size: +(1.2 + depth * 2.8).toFixed(2),
    drift: +(10 + pRng() * 26).toFixed(1),
    dur,
    delay: +(-pRng() * dur).toFixed(1),
    tdur: +(3.5 + pRng() * 5).toFixed(1),
    op: +(0.22 + depth * 0.55).toFixed(2),
    hue: pRng() > 0.5 ? 'saffron' : 'violet',
  }
})

const sRng = makeRng(0x1f83d9ab)
const sparks = Array.from({ length: SPARK_COUNT }, () => {
  const dur = +(6 + sRng() * 11).toFixed(1)
  const angle = sRng() * Math.PI * 2
  const dist = 14 + sRng() * 30
  return {
    left: +(sRng() * 100).toFixed(2),
    top: +(sRng() * 100).toFixed(2),
    size: +(6 + sRng() * 9).toFixed(1),
    dx: +(Math.cos(angle) * dist).toFixed(1),
    dy: +(Math.sin(angle) * dist).toFixed(1),
    rot: +((sRng() - 0.5) * 70).toFixed(1),
    dur,
    delay: +(-sRng() * dur).toFixed(1),
    tdur: +(2.5 + sRng() * 4).toFixed(1),
    op: +(0.35 + sRng() * 0.5).toFixed(2),
    hue: sRng() > 0.45 ? 'saffron' : 'violet',
  }
})

type VarStyle = CSSProperties & Record<`--${string}`, string>

export function CosmicStarfield(): ReactNode {
  return (
    <div className="ophis-starfield" aria-hidden="true">
      {particles.map((p, i) => (
        <span
          key={`p${i}`}
          className={`ophis-particle ophis-particle--${p.hue}`}
          style={
            {
              left: `${p.left}%`,
              top: `${p.top}%`,
              width: `${p.size}px`,
              height: `${p.size}px`,
              '--drift': `${p.drift}px`,
              '--dur': `${p.dur}s`,
              '--delay': `${p.delay}s`,
              '--tdur': `${p.tdur}s`,
              '--op': `${p.op}`,
            } as VarStyle
          }
        />
      ))}
      {sparks.map((s, i) => (
        <span
          key={`s${i}`}
          className={`ophis-spark ophis-spark--${s.hue}`}
          style={
            {
              left: `${s.left}%`,
              top: `${s.top}%`,
              width: `${s.size}px`,
              height: `${s.size}px`,
              '--dx': `${s.dx}px`,
              '--dy': `${s.dy}px`,
              '--rot': `${s.rot}deg`,
              '--dur': `${s.dur}s`,
              '--delay': `${s.delay}s`,
              '--tdur': `${s.tdur}s`,
              '--op': `${s.op}`,
            } as VarStyle
          }
        />
      ))}
    </div>
  )
}
