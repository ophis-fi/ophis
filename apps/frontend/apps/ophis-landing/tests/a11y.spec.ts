import { test, expect } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'

// Prevent the returning-trader localStorage redirect (Base.astro) from firing
// mid-test and destroying the execution context (a flaky-deploy source).
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    try { window.localStorage.removeItem('ophis_wallet_connected') } catch { /* ignore */ }
  })
})

test('landing has no axe-core a11y violations', async ({ page }) => {
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  const results = await new AxeBuilder({ page }).analyze()
  // AA color-contrast target: 0 violations after faded token bump (0.4→0.5)
  // heading-order: fixed by Footer h5→h3
  expect(results.violations).toEqual([])
})
