import { test, expect } from '@playwright/test'

test('final CTA shows new multi-chain headline + Trade CTA', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.final h2')).toContainText('Trade anywhere')
  await expect(page.locator('.final h2')).toContainText('Settle in one batch')
  await expect(page.locator('.final p')).toContainText('12 chains')
  await expect(page.locator('.final .cta-primary')).toContainText(/Trade/)
})

test('footer has 4 columns + nav-back-to-top link', async ({ page }) => {
  await page.goto('/')
  const cols = page.locator('.footer .footer-col')
  await expect(cols).toHaveCount(4)
  await expect(page.locator('.footer .copyright')).toContainText('2026')
  // GPL-3.0 intentionally removed from the footer.
  await expect(page.locator('.footer .copyright')).not.toContainText('GPL')
})
