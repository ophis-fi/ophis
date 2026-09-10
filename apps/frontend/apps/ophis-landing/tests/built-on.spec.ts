import { test, expect } from '@playwright/test'

test('built-on strip lists 5 partner items including CoW Protocol and Trail of Bits', async ({ page }) => {
  await page.goto('/')
  const items = page.locator('.built-on .built-item')
  await expect(items).toHaveCount(5)
  const names = await page.locator('.built-on .built-name').allTextContents()
  expect(names).toContain('CoW Protocol')
  expect(names).toContain('Trail of Bits')
  expect(names).toContain('Aleph Cloud')
  expect(names).toContain('LibertAI')
  expect(names).toContain('NEAR Intents')
  // Bungee's API is permanently gone and the swap app no longer routes
  // through it (2026-09-10); the strip must not claim it as a partner.
  expect(names).not.toContain('Bungee')
})

test('built-on strip has updated headline and subhead', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.built-on h2')).toContainText('Built with the tools and partners')
  await expect(page.locator('.built-on .sub')).toContainText('Forked from CoW Protocol')
  await expect(page.locator('.built-on .sub')).not.toContainText('Bungee')
})
