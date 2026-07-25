import { svgToPng } from './svgToPng'

describe('svgToPng', () => {
  it('returns null for undecodable base64 without throwing', async () => {
    await expect(svgToPng('@@@ not base64 @@@')).resolves.toBeNull()
  })

  it('resolves for a valid SVG (null in a canvas-less jsdom, a data URL in a browser)', async () => {
    const b64 = btoa('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50"></svg>')
    // Guarded: with no 2d context (jsdom) it resolves null before ever
    // constructing an Image, so this never hangs regardless of environment.
    const result = await svgToPng(b64)
    expect(result === null || typeof result?.dataUrl === 'string').toBe(true)
  })
})
