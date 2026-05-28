import { test, expect } from '@playwright/test'

test('hero has headline, accent word, two CTAs', async ({ page }) => {
  await page.goto('/')
  const h1 = page.locator('.hero h1')
  await expect(h1).toContainText('DEX aggregator')
  await expect(h1).toContainText('agent era')
  await expect(page.locator('.hero .accent')).toContainText('agent era')
  await expect(page.locator('.hero .cta-primary')).toContainText(/Trade/)
  await expect(page.locator('.hero .cta-secondary')).toContainText(/Read docs/)
})

test('hero is single-column centered (no claw image)', async ({ page }) => {
  await page.goto('/')
  // No claw img in hero
  const clawImg = page.locator('.hero img')
  await expect(clawImg).toHaveCount(0)
  // Hero copy is centered
  const heroCopy = page.locator('.hero-inner')
  await expect(heroCopy).toBeVisible()
})
