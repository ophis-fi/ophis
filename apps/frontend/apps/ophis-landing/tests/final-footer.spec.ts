import { test, expect } from '@playwright/test'

test('final CTA shows reimagined headline + Launch app', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.final h2')).toContainText('reimagined')
  await expect(page.locator('.final .cta-primary')).toContainText(/Launch app/)
})

test('footer has 4 columns + nav-back-to-top link', async ({ page }) => {
  await page.goto('/')
  const cols = page.locator('.footer .footer-col')
  await expect(cols).toHaveCount(4)
  await expect(page.locator('.footer .copyright')).toContainText('2026')
  await expect(page.locator('.footer .copyright')).toContainText('GPL-3.0')
})
