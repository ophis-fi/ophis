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

test('Geist font is preloaded', async ({ page }) => {
  await page.goto('/')
  const links = page.locator('link[rel="preload"][as="font"]')
  await expect(links).toHaveCount(1)
  const href = await links.getAttribute('href')
  expect(href).toContain('geist-sans')
})
