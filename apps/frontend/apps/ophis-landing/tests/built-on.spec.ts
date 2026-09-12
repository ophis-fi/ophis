import { test, expect } from '@playwright/test'

test('built-on strip lists 5 partner items including CoW Protocol and Trail of Bits', async ({ page }) => {
  await page.goto('/')
  const items = page.locator('.built-on .built-item')
  await expect(items).toHaveCount(5)
  const names = await page.locator('.built-on .built-name').allTextContents()
  expect(names).toContain('CoW Protocol')
  expect(names).toContain('Trail of Bits')
  expect(names).toContain('Aleph Cloud')
  expect(names).toContain('Across')
  expect(names).not.toContain('LibertAI')
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

test('venue grid includes the requested DEXs and identifies the pending integration', async ({ page }) => {
  await page.goto('/')
  const grid = page.locator('.protocol-grid')
  for (const name of ['RamsesX', 'Dexalot', 'Native', 'Pharaoh', 'Arcus']) {
    await expect(grid.getByText(name, { exact: true })).toBeVisible()
  }
  await expect(grid.getByText('Pons', { exact: true })).toHaveCount(0)
  const pending = grid.locator('.protocol').filter({ hasText: 'Integration pending' })
  await expect(pending).toHaveCount(1)
  await expect(pending).toContainText('Arcus')
  const unverified = grid.locator('.protocol').filter({ hasText: 'Routing unverified' })
  await expect(unverified).toHaveCount(4)
  await expect(unverified).toContainText(['RamsesX', 'Dexalot', 'Native', 'Pharaoh'])
})
