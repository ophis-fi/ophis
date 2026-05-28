import { test, expect } from '@playwright/test'

test('built-on strip lists 6 partner items including CoW Protocol and Trail of Bits', async ({ page }) => {
  await page.goto('/')
  const items = page.locator('.built-on .built-item')
  await expect(items).toHaveCount(6)
  const names = await page.locator('.built-on .built-name').allTextContents()
  expect(names).toContain('CoW Protocol')
  expect(names).toContain('Trail of Bits')
  expect(names).toContain('Aleph Cloud')
  expect(names).toContain('LibertAI')
  expect(names).toContain('NEAR Intents')
  expect(names).toContain('Bungee')
})

test('built-on strip has updated headline and subhead', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.built-on h2')).toContainText('Built with the tools and partners')
  await expect(page.locator('.built-on .sub')).toContainText('Forked from CoW Protocol')
})
