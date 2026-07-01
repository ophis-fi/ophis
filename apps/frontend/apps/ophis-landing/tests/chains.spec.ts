import { test, expect } from '@playwright/test'

const EXPECTED_CHAINS = [
  'Ethereum', 'BNB', 'Base', 'Arbitrum', 'Polygon', 'Avalanche',
  'Linea', 'Plasma', 'Ink', 'Gnosis', 'Optimism', 'Unichain',
  'Solana', 'Bitcoin',
]

test('chains strip lists 14 chains in order', async ({ page }) => {
  await page.goto('/')
  // The marquee renders an aria-hidden [data-clone] duplicate for a seamless
  // loop; count only the real, accessible set.
  const items = page.locator('.chains .chain:not([data-clone])')
  await expect(items).toHaveCount(14)
  for (let i = 0; i < EXPECTED_CHAINS.length; i++) {
    await expect(items.nth(i)).toContainText(EXPECTED_CHAINS[i])
  }
})

test('Solana and Bitcoin are labeled "via NEAR"', async ({ page }) => {
  await page.goto('/')
  // The marquee renders an aria-hidden [data-clone] duplicate for a seamless
  // loop; count only the real, accessible set.
  const items = page.locator('.chains .chain:not([data-clone])')
  await expect(items.nth(12)).toContainText('via NEAR') // Solana
  await expect(items.nth(13)).toContainText('via NEAR') // Bitcoin
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
