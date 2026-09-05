import { test, expect } from '@playwright/test'

test('final CTA presents the trade and integration paths', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.final h2')).toContainText('One intent')
  await expect(page.locator('.final h2')).toContainText('A better way to settle')
  await expect(page.locator('.final p')).toContainText('supported stablecoins and tokenized assets')
  await expect(page.locator('.final .cta-primary')).toHaveAttribute('href', 'https://swap.ophis.fi/')
  await expect(page.locator('.final .cta-secondary')).toHaveAttribute('href', '/ai-agent-crypto-swap-api/')
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
