import { test, expect } from '@playwright/test'

test('hero has headline, accent word, two CTAs, claw image', async ({ page }) => {
  await page.goto('/')
  const h1 = page.locator('.hero h1')
  await expect(h1).toContainText('DEX aggregator')
  await expect(h1).toContainText('agent era')
  await expect(page.locator('.hero .accent')).toContainText('agent era')
  await expect(page.locator('.hero .cta-primary')).toContainText(/Launch app/)
  await expect(page.locator('.hero .cta-secondary')).toContainText(/Read docs/)
  await expect(page.locator('.hero img[alt=""], .hero img[alt="Ophis"]')).toBeVisible()
})

test('hero claw has animation paused under prefers-reduced-motion', async ({ browser }) => {
  const context = await browser.newContext({ reducedMotion: 'reduce' })
  const page = await context.newPage()
  await page.goto('/')
  const anim = await page.locator('.hero .claw').evaluate(el => getComputedStyle(el).animationName)
  expect(anim).toBe('none')
})
