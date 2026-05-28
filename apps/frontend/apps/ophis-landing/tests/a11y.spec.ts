import { test, expect } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'

test('landing has no axe-core a11y violations', async ({ page }) => {
  await page.goto('/')
  const results = await new AxeBuilder({ page }).analyze()
  // AA color-contrast target: 0 violations after faded token bump (0.4→0.5)
  // heading-order: fixed by Footer h5→h3
  expect(results.violations).toEqual([])
})
