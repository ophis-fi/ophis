import { test, expect } from '@playwright/test'

test('feature grid renders MEV and SDK cards', async ({ page }) => {
  await page.goto('/')
  const cards = page.locator('.features .feat')
  await expect(cards).toHaveCount(2)
  await expect(cards.nth(0)).toContainText('MEV protection')
  await expect(cards.nth(1)).toContainText(/Agent.*safety/)
})

test('feature cards each have an icon SVG', async ({ page }) => {
  await page.goto('/')
  const icons = page.locator('.features .feat svg.feat-icon')
  await expect(icons).toHaveCount(2)
})
