/**
 * Rasterize a base64 SVG to a PNG data URL. jsPDF cannot embed SVG, so the
 * pathviz diagram is drawn onto a 2x canvas first and added to the PDF as a
 * PNG. Best-effort and browser-only: returns null on any failure (no canvas,
 * decode error, tainted canvas) so PDF export always proceeds.
 */

/** Oversampling factor: 2x keeps the vector-crisp diagram readable in print. */
const SCALE = 2

export interface SvgToPngResult {
  /** `data:image/png;base64,...` data URL. */
  readonly dataUrl: string
  /** Rendered pixel width (already scaled). */
  readonly width: number
  /** Rendered pixel height (already scaled). */
  readonly height: number
}

/** Parse the intrinsic width/height out of the SVG root, defaulting to 960x540. */
function readDimensions(svg: string): { width: number; height: number } {
  const w = svg.match(/<svg[^>]*\bwidth="([\d.]+)"/)
  const h = svg.match(/<svg[^>]*\bheight="([\d.]+)"/)
  return {
    width: w ? Number(w[1]) : 960,
    height: h ? Number(h[1]) : 540,
  }
}

export async function svgToPng(pathVizSvgBase64: string): Promise<SvgToPngResult | null> {
  if (typeof document === 'undefined') return null
  let svg: string
  try {
    // Decode base64 -> UTF-8 string to read intrinsic dimensions.
    const binary = atob(pathVizSvgBase64)
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0))
    svg = new TextDecoder().decode(bytes)
  } catch {
    return null
  }

  const { width, height } = readDimensions(svg)
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(width * SCALE)
  canvas.height = Math.round(height * SCALE)
  const ctx = canvas.getContext('2d')
  if (!ctx) return null

  const dataUrl = await new Promise<string | null>((resolve) => {
    const img = new Image()
    img.onload = () => {
      try {
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
        resolve(canvas.toDataURL('image/png'))
      } catch {
        resolve(null)
      }
    }
    img.onerror = () => resolve(null)
    // Feeding the SVG via a data URL keeps the canvas untainted.
    img.src = `data:image/svg+xml;base64,${pathVizSvgBase64}`
  })

  if (!dataUrl) return null
  return { dataUrl, width: canvas.width, height: canvas.height }
}
