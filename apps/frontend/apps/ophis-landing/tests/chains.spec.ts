import { test, expect } from '@playwright/test'

const EXPECTED_CHAINS = [
  'Ethereum', 'BNB', 'Base', 'Arbitrum', 'Polygon', 'Avalanche',
  'Linea', 'Plasma', 'Ink', 'Gnosis', 'Optimism', 'Unichain', 'Robinhood',
  'Solana', 'Bitcoin', 'Monad', 'Hyperliquid', 'X Layer', 'Sui', 'Tron',
]

test('chains strip lists supported networks in order', async ({ page }) => {
  await page.goto('/')
  // The marquee renders an aria-hidden [data-clone] duplicate for a seamless
  // loop; count only the real, accessible set.
  const items = page.locator('.chains .chain:not([data-clone])')
  await expect(items).toHaveCount(EXPECTED_CHAINS.length)
  for (let i = 0; i < EXPECTED_CHAINS.length; i++) {
    await expect(items.nth(i)).toContainText(EXPECTED_CHAINS[i])
  }
})

test('network marks load without route labels', async ({ page }) => {
  await page.goto('/')
  // The marquee renders an aria-hidden [data-clone] duplicate for a seamless
  // loop; count only the real, accessible set.
  const items = page.locator('.chains .chain:not([data-clone])')
  await expect(page.locator('.chains')).not.toContainText('via NEAR')
  for (const img of await items.locator('img').all()) {
    await img.evaluate((el: HTMLImageElement) => { el.loading = 'eager' })
    await img.evaluate((el: HTMLImageElement) => el.decode())
    expect(await img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0)
  }
})

test('chains marquee has a keyboard-operable pause, hidden until focused (WCAG 2.2.2)', async ({ page }) => {
  await page.goto('/')
  const input = page.locator('.chains-pause-input')
  const btn = page.locator('.chains-pause-btn')
  // Invisible to mouse users by default (no clutter on the logo strip).
  await expect(btn).toHaveCSS('opacity', '0')
  // Keyboard focus reveals it (the input is sr-only, so focus directly and
  // activate with Space — .check() would reject the hidden input).
  await input.focus()
  await expect(btn).toHaveCSS('opacity', '1')
  await page.keyboard.press('Space')
  await expect(page.locator('.chains-track')).toHaveCSS('animation-play-state', 'paused')
})

test('FAQ and machine-readable summaries match the supported destinations', async ({ page }) => {
  await page.goto('/')
  const faq = page.locator('details').filter({ hasText: 'Which chains does Ophis support?' })
  const schemas = (await page.locator('script[type="application/ld+json"]').allTextContents()).map((text) => JSON.parse(text))
  const software = schemas.find((schema) => schema['@type'] === 'SoftwareApplication')
  const llms = await (await page.request.get('/llms.txt')).text()
  for (const name of EXPECTED_CHAINS.slice(13)) {
    await expect(faq).toContainText(name)
    expect(software.description).toContain(name)
    expect(llms).toContain(name)
  }
})
