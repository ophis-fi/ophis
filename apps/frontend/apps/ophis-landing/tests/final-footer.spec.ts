import { test, expect } from '@playwright/test'

test('final CTA presents the swap and docs paths', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.final h2')).toContainText('Your next move.')
  await expect(page.locator('.final h2')).toContainText('On your terms.')
  await expect(page.locator('.final p')).toContainText('Choose your assets. Check your limits.')
  await expect(page.locator('.final .cta-primary')).toHaveAttribute('href', 'https://swap.ophis.fi/#/swap')
  await expect(page.locator('.final .cta-secondary')).toHaveAttribute('href', 'https://docs.ophis.fi')
})

test('footer has 4 columns + nav-back-to-top link', async ({ page }) => {
  await page.goto('/')
  const cols = page.locator('.footer .footer-col')
  await expect(cols).toHaveCount(4)
  await expect(page.locator('.footer .copyright')).toContainText('2026')
  await expect(page.locator('.footer .made-in-luxembourg')).toHaveText('Made in Luxembourg')
  await expect(page.locator('.footer a[aria-label="Telegram"]')).toHaveAttribute('href', 'https://t.me/ophisfi')
  // GPL-3.0 intentionally removed from the footer.
  await expect(page.locator('.footer .copyright')).not.toContainText('GPL')
})
