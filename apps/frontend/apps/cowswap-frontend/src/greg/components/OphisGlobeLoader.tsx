/**
 * OphisGlobeLoader — 200×200 monochrome globe loader.
 *
 * Spec from Clement (2026-05-10): orthographic projection of the
 * world-atlas country topology, slowly rotating with a slight axial
 * tilt. Three Ophie ouroboros marks orbit it at different radii and
 * speeds (counter-spin on the middle ring, faster on the outer)
 * replacing the original three "whirl layers" spec — gives the
 * orbital "loading" feel without abstract arcs.
 *
 * Palette: warm off-white background, single near-black ink. The
 * loader is a paper card sitting on the dark cosmic landing.
 *
 * The TopoJSON data ships at /data/countries-110m.json (~105 KB,
 * cached one-month-immutable via _headers). Decoded once on mount,
 * then drawn into canvas every frame via requestAnimationFrame.
 */
import { ReactNode, useEffect, useRef, useState } from 'react'

import { geoOrthographic, geoPath, GeoPermissibleObjects } from 'd3-geo'
import styled, { keyframes } from 'styled-components/macro'
import { feature } from 'topojson-client'

import { OPHIE_PAD_X, OPHIE_PATH, OPHIE_VIEWBOX } from '../ophiePath'

// Minimal TopoJSON shape we read at runtime — avoids the
// topojson-specification dep-of-deps just for two type names.
interface TopoCountriesObject {
  type: 'GeometryCollection'
}
interface TopoCountries {
  type: 'Topology'
  objects: { countries: TopoCountriesObject }
}

interface Props {
  size?: number
  className?: string
  /** Optional aria-label override; defaults to 'Loading'. */
  ariaLabel?: string
}

const DEFAULT_SIZE = 200
const AXIAL_TILT_DEG = -23.5
const ROTATION_PERIOD_MS = 60_000

const PAPER = '#FAF6EE' // warm off-white
const INK = '#0F0E0B' // near-black

let cachedLand: GeoPermissibleObjects | null = null

async function loadLand(): Promise<GeoPermissibleObjects> {
  if (cachedLand) return cachedLand
  const r = await fetch('/data/countries-110m.json')
  if (!r.ok) throw new Error('failed to load topology')
  const topo = (await r.json()) as TopoCountries
  // topojson-client's `feature()` is loosely typed across major
  // versions; cast through unknown to land on the d3-geo input shape.
  cachedLand = feature(topo as never, topo.objects.countries as never) as unknown as GeoPermissibleObjects
  return cachedLand
}

const Wrap = styled.div<{ $size: number }>`
  position: relative;
  width: ${({ $size }) => $size}px;
  height: ${({ $size }) => $size}px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 999px;
  background: ${PAPER};
  color: ${INK};
  /* Subtle paper edge — looks intentional on the dark cosmic page. */
  box-shadow:
    0 1px 0 rgba(15, 14, 11, 0.04) inset,
    0 0 0 1px rgba(15, 14, 11, 0.06),
    0 12px 32px rgba(0, 0, 0, 0.32),
    0 2px 6px rgba(0, 0, 0, 0.18);
`

const GlobeCanvas = styled.canvas<{ $diameter: number }>`
  position: absolute;
  top: 50%;
  left: 50%;
  width: ${({ $diameter }) => $diameter}px;
  height: ${({ $diameter }) => $diameter}px;
  transform: translate(-50%, -50%);
  display: block;
`

const spin = keyframes`
  from { transform: translate(-50%, -50%) rotate(0deg); }
  to   { transform: translate(-50%, -50%) rotate(360deg); }
`

const Orbit = styled.div<{
  $diameter: number
  $duration: string
  $direction: 'normal' | 'reverse'
  $delay: string
}>`
  position: absolute;
  top: 50%;
  left: 50%;
  width: ${({ $diameter }) => $diameter}px;
  height: ${({ $diameter }) => $diameter}px;
  transform: translate(-50%, -50%);
  pointer-events: none;
  animation: ${spin} ${({ $duration }) => $duration}
    linear infinite;
  animation-direction: ${({ $direction }) => $direction};
  animation-delay: ${({ $delay }) => $delay};
`

const OphieDot = styled.svg<{ $size: number; $opacity: number }>`
  position: absolute;
  top: 0;
  left: 50%;
  width: ${({ $size }) => $size}px;
  height: ${({ $size }) => $size}px;
  transform: translate(-50%, -50%);
  opacity: ${({ $opacity }) => $opacity};
`

interface OrbitConfig {
  ratio: number // orbit diameter / wrapper size
  ophieSize: number
  duration: string
  direction: 'normal' | 'reverse'
  opacity: number
  delay: string
}

const ORBITS: OrbitConfig[] = [
  { ratio: 0.78, ophieSize: 16, duration: '9s', direction: 'normal', opacity: 0.7, delay: '0s' },
  { ratio: 0.9, ophieSize: 14, duration: '14s', direction: 'reverse', opacity: 0.45, delay: '-3s' },
  { ratio: 0.98, ophieSize: 12, duration: '22s', direction: 'normal', opacity: 0.28, delay: '-7s' },
]

export function OphisGlobeLoader({ size = DEFAULT_SIZE, className, ariaLabel = 'Loading' }: Props): ReactNode {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [ready, setReady] = useState(cachedLand !== null)
  const globeDiameter = Math.round(size * 0.66)

  useEffect(() => {
    let raf = 0
    let cancelled = false
    let land: GeoPermissibleObjects | null = cachedLand

    function startLoop(): void {
      const canvas = canvasRef.current
      if (!canvas || !land) return
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      const px = globeDiameter * dpr
      canvas.width = px
      canvas.height = px
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.scale(dpr, dpr)
      ctx.lineWidth = 0.6

      const projection = geoOrthographic()
        .scale(globeDiameter / 2 - 1)
        .translate([globeDiameter / 2, globeDiameter / 2])
        .clipAngle(90)

      const path = geoPath(projection, ctx)
      const sphere: GeoPermissibleObjects = { type: 'Sphere' } as GeoPermissibleObjects

      function tick(t: number): void {
        if (cancelled || !ctx || !land) return
        const lambda = (t / ROTATION_PERIOD_MS) * 360
        projection.rotate([lambda, AXIAL_TILT_DEG, 0])

        ctx.clearRect(0, 0, globeDiameter, globeDiameter)

        // Sphere outline (paper-ink contrast).
        ctx.beginPath()
        path(sphere)
        ctx.strokeStyle = INK
        ctx.globalAlpha = 0.55
        ctx.stroke()

        // Land masses.
        ctx.beginPath()
        path(land)
        ctx.fillStyle = INK
        ctx.globalAlpha = 1
        ctx.fill()

        raf = requestAnimationFrame(tick)
      }

      raf = requestAnimationFrame(tick)
    }

    if (land) {
      startLoop()
    } else {
      loadLand()
        .then((l) => {
          if (cancelled) return
          land = l
          setReady(true)
          startLoop()
        })
        .catch(() => {
          /* swallow — loader will simply show without the globe */
        })
    }

    return () => {
      cancelled = true
      if (raf) cancelAnimationFrame(raf)
    }
  }, [globeDiameter])

  return (
    <Wrap className={className} $size={size} role="status" aria-label={ariaLabel}>
      <GlobeCanvas ref={canvasRef} $diameter={globeDiameter} aria-hidden style={{ opacity: ready ? 1 : 0 }} />
      {ORBITS.map((orbit, i) => {
        const orbitDiameter = Math.round(size * orbit.ratio)
        return (
          <Orbit
            key={i}
            $diameter={orbitDiameter}
            $duration={orbit.duration}
            $direction={orbit.direction}
            $delay={orbit.delay}
            aria-hidden
          >
            <OphieDot
              $size={orbit.ophieSize}
              $opacity={orbit.opacity}
              viewBox={OPHIE_VIEWBOX}
            >
              <g transform={`translate(${OPHIE_PAD_X},0)`}>
                <path d={OPHIE_PATH} fill={INK} />
              </g>
            </OphieDot>
          </Orbit>
        )
      })}
    </Wrap>
  )
}
