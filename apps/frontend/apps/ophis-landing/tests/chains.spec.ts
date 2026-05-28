import { test, expect } from '@playwright/test'

test('chains strip lists 5 chains with proper status', async ({ page }) => {
  await page.goto('/')
  const items = page.locator('.chains .chain')
  await expect(items).toHaveCount(5)
  await expect(items.nth(0)).toContainText('Optimism')
  await expect(items.nth(1)).toContainText(/HyperEVM/)
  await expect(items.nth(1)).toContainText(/paused/)
  await expect(items.nth(3)).toContainText(/via NEAR/)
})
