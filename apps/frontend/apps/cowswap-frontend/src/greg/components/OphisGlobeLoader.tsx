/**
 * OphisGlobeLoader — monochrome cosmic globe with the Ophie ouroboros
 * orbiting around it.
 *
 * Visual: a slowly rotating earth (orthographic projection of the
 * world-atlas country topology, drawn into canvas every frame), with
 * a single Ophie mark sliding around it on a circular orbit and
 * counter-spinning on its own axis as it travels — so the loop reads
 * as "Ophis circling the planet" rather than three random arcs.
 *
 * Palette: cosmic indigo card on the dark page, cream ink for both
 * the land masses and the Ophie. Match the rest of the Ophis dark
 * surfaces (paper #13072B, ink #F5EFE6) so the loader plugs cleanly
 * into any pending state.
 *
 * Topology data ships at /data/countries-110m.json (~105 KB, cached
 * one-month-immutable via _headers). Decoded once on mount, then
 * drawn each frame via requestAnimationFrame.
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

const PAPER = '#13072B' // cosmic card surface
const INK = '#F5EFE6' // cream ink
const SPHERE_INK = 'rgba(245, 239, 230, 0.40)'

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
  /* Subtle paper edge so the loader reads as a small disc on the dark page. */
  box-shadow:
    0 1px 0 rgba(255, 255, 255, 0.05) inset,
    0 0 0 1px rgba(245, 239, 230, 0.08),
    0 12px 32px rgba(0, 0, 0, 0.55),
    0 2px 6px rgba(0, 0, 0, 0.32);
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

// Orbit container spins around the disc center; the Ophie mark sits
// pinned to the top of that container so as the container rotates,
// the mark traces a circle around the globe.
const orbitSpin = keyframes`
  from { transform: translate(-50%, -50%) rotate(0deg); }
  to   { transform: translate(-50%, -50%) rotate(360deg); }
`

// Counter-spin keeps the Ophie mark visually upright (or gives it a
// subtle independent tumble) while it orbits.
const ophieSpin = keyframes`
  from { transform: translate(-50%, -50%) rotate(0deg); }
  to   { transform: translate(-50%, -50%) rotate(-360deg); }
`

const Orbit = styled.div<{ $diameter: number }>`
  position: absolute;
  top: 50%;
  left: 50%;
  width: ${({ $diameter }) => $diameter}px;
  height: ${({ $diameter }) => $diameter}px;
  transform: translate(-50%, -50%);
  pointer-events: none;
  animation: ${orbitSpin} 8s linear infinite;
`

const OphieDot = styled.svg<{ $size: number }>`
  position: absolute;
  top: 0;
  left: 50%;
  width: ${({ $size }) => $size}px;
  height: ${({ $size }) => $size}px;
  transform: translate(-50%, -50%);
  filter: drop-shadow(0 2px 6px rgba(0, 0, 0, 0.55));
  animation: ${ophieSpin} 8s linear infinite;
`

export function OphisGlobeLoader({ size = DEFAULT_SIZE, className, ariaLabel = 'Loading' }: Props): ReactNode {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [ready, setReady] = useState(cachedLand !== null)
  const globeDiameter = Math.round(size * 0.62)
  const orbitDiameter = Math.round(size * 0.92)
  const ophieSize = Math.max(14, Math.round(size * 0.14))

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

        // Sphere outline.
        ctx.beginPath()
        path(sphere)
        ctx.strokeStyle = SPHERE_INK
        ctx.globalAlpha = 1
        ctx.stroke()

        // Land masses.
        ctx.beginPath()
        path(land)
        ctx.fillStyle = INK
        ctx.globalAlpha = 0.95
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
      <Orbit $diameter={orbitDiameter} aria-hidden>
        <OphieDot $size={ophieSize} viewBox={OPHIE_VIEWBOX}>
          <g transform={`translate(${OPHIE_PAD_X},0)`}>
            <path d={OPHIE_PATH} fill={INK} />
          </g>
        </OphieDot>
      </Orbit>
    </Wrap>
  )
}
