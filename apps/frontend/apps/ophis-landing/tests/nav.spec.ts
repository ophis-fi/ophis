import { test, expect } from '@playwright/test'

test('nav renders logo + nav links + Launch app CTA', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.nav .logo')).toHaveText('Ophis')
  const links = page.locator('.nav .nav-links a')
  await expect(links).toHaveCount(5)
  await expect(page.locator('.nav .nav-cta')).toHaveText(/Launch app/)
})

test('nav becomes frosted past scroll threshold', async ({ page }) => {
  await page.goto('/')
  await page.setViewportSize({ width: 1200, height: 800 })
  // Ensure document has enough height to scroll
  await page.evaluate(() => {
    document.body.style.minHeight = '3000px'
  })
  await expect(page.locator('.nav')).not.toHaveClass(/scrolled/)
  await page.evaluate(() => window.scrollTo(0, 200))
  await page.waitForTimeout(80)
  await expect(page.locator('.nav')).toHaveClass(/scrolled/)
})
