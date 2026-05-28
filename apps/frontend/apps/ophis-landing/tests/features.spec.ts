import { test, expect } from '@playwright/test'

test('feature grid renders MEV / Rebates / SDK cards', async ({ page }) => {
  await page.goto('/')
  const cards = page.locator('.features .feat')
  await expect(cards).toHaveCount(3)
  await expect(cards.nth(0)).toContainText('MEV protection')
  await expect(cards.nth(1)).toContainText(/[Vv]olume.*[Rr]ebate/)
  await expect(cards.nth(2)).toContainText(/Agent.*safety/)
})
