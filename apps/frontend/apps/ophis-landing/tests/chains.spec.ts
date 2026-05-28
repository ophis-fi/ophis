import { test, expect } from '@playwright/test'

const EXPECTED_CHAINS = [
  'Ethereum', 'BNB', 'Base', 'Arbitrum', 'Polygon', 'Avalanche',
  'Linea', 'Plasma', 'Ink', 'Gnosis', 'Optimism',
  'Solana', 'Bitcoin',
]

test('chains strip lists 13 chains in order', async ({ page }) => {
  await page.goto('/')
  const items = page.locator('.chains .chain')
  await expect(items).toHaveCount(13)
  for (let i = 0; i < EXPECTED_CHAINS.length; i++) {
    await expect(items.nth(i)).toContainText(EXPECTED_CHAINS[i])
  }
})

test('Solana and Bitcoin are labeled "via NEAR"', async ({ page }) => {
  await page.goto('/')
  const items = page.locator('.chains .chain')
  await expect(items.nth(11)).toContainText('via NEAR') // Solana
  await expect(items.nth(12)).toContainText('via NEAR') // Bitcoin
})
