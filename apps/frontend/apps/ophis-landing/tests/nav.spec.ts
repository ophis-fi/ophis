import { test, expect } from '@playwright/test'

test('nav renders logo (with SVG claw) + nav links + Trade CTA', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.nav .logo')).toContainText('Ophis')
  // Logo should contain an inline SVG (the claw)
  await expect(page.locator('.nav .logo svg.logo-claw')).toBeVisible()
  const links = page.locator('.nav .nav-links a')
  await expect(links).toHaveCount(5)
  await expect(page.locator('.nav .nav-cta')).toHaveText(/Trade/)
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
