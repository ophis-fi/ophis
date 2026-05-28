import { test, expect } from '@playwright/test'

test('built-on strip lists CoW Protocol + Foundry + Alloy + CF Pages + OP Stack', async ({ page }) => {
  await page.goto('/')
  const items = page.locator('.built-on .built-item')
  await expect(items).toHaveCount(5)
  const texts = await items.allTextContents()
  expect(texts).toContain('CoW Protocol')
  expect(texts).toContain('Foundry')
  expect(texts).toContain('Alloy')
  expect(texts).toContain('Cloudflare Pages')
  expect(texts).toContain('OP Stack')
})
