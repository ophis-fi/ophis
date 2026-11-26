import { test, expect } from '@playwright/test'

test('Base layout renders Ophis meta + redirect script', async ({ page }) => {
  await page.goto('/')
  expect(await page.title()).toContain('Ophis')
  const ogTitle = await page.locator('meta[property="og:title"]').getAttribute('content')
  expect(ogTitle).toContain('Ophis')
  // redirect script must check localStorage + use the literal swap subdomain
  const html = await page.content()
  expect(html).toContain('ophis_wallet_connected')
  expect(html).toContain("'https://swap.ophis.fi/'")
})

test('body text prefers local Neue Haas Unica Pro and headings retain Georgia', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('body')).toHaveCSS('font-family', /^["']?Neue Haas Unica Pro["']?, system-ui, sans-serif$/)
  await expect(page.locator('#heroTitle')).toHaveCSS('font-family', /^Georgia,/)
  await expect(page.locator('link[rel="preload"][as="font"]')).toHaveCount(0)
})
