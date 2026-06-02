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

test('mobile nav: hamburger opens the drawer; Escape closes it and restores scroll + focus', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  const burger = page.locator('#nav-burger')
  const drawer = page.locator('#nav-drawer')
  // On mobile the burger replaces the (now-hidden) desktop links.
  await expect(burger).toBeVisible()
  await expect(page.locator('.nav .nav-links')).toBeHidden()
  // Drawer mirrors the 5 links + the Trade CTA.
  await expect(page.locator('#nav-drawer .nav-drawer-links a')).toHaveCount(6)
  // Open.
  await burger.click()
  await expect(burger).toHaveAttribute('aria-expanded', 'true')
  await expect(drawer).toHaveAttribute('data-open', 'true')
  expect(await drawer.evaluate((d) => d.contains(document.activeElement))).toBe(true)
  expect(await page.evaluate(() => getComputedStyle(document.body).overflow)).toBe('hidden')
  // Escape closes, restores body scroll, and returns focus to the burger.
  await page.keyboard.press('Escape')
  await expect(burger).toHaveAttribute('aria-expanded', 'false')
  await expect(drawer).toHaveAttribute('data-open', 'false')
  expect(await page.evaluate(() => getComputedStyle(document.body).overflow)).toBe('visible')
  expect(await burger.evaluate((b) => document.activeElement === b)).toBe(true)
})
